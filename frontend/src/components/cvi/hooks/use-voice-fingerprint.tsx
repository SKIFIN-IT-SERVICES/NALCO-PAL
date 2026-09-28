import { useCallback, useEffect, useRef, useState } from 'react';
import { useAudioTrack, useLocalSessionId } from '@daily-co/daily-react';
import { useObservableEvent } from './cvi-events-hooks';

/**
 * Best-effort "is this still the same visitor talking?" signal, built from
 * scratch because Tavus does not provide one: its transcripts label every
 * human turn simply `role: "user"` with no speaker id, and its STT layer
 * (`stt_engine` + `hotwords`) has no diarization or speaker-identification
 * option. This was confirmed by pulling a real past conversation's
 * transcript via the API and inspecting every field it records per turn —
 * not assumed from the docs.
 *
 * WHAT THIS ACTUALLY IS: a pitch (fundamental frequency) + timbre (spectral
 * centroid) comparison against a running baseline for "the current
 * speaker," computed locally in the browser from the kiosk's own
 * microphone. It is NOT speaker verification/embeddings — there is no ML
 * model here, just two classical acoustic features. That means it reliably
 * catches a large voice change (adult ↔ child, most male ↔ female
 * transitions) and will often miss a subtle one (two adults of similar
 * pitch and vocal tract length). Treat its output as a *hint*, not a
 * guarantee — see NALCO_PAL_ENGAGEMENT_PLAN's session-boundary section for
 * the two-directional failure mode this implies.
 *
 * Windowed to the visitor's own speech only, via the exact
 * `conversation.user.started_speaking` / `...stopped_speaking` boundaries
 * Tavus already emits — never analyzing the PAL's own voice or ambient
 * noise between turns.
 */

const MIN_VOICE_HZ = 75; // below typical adult male fundamental
const MAX_VOICE_HZ = 400; // above typical adult female fundamental
const SAMPLE_INTERVAL_MS = 150;
// Safety net: if `stopped_speaking` is ever missed or arrives out of order
// (observed during testing — repeated back-and-forth switching eventually
// causes detection to silently stop working entirely), no real utterance
// runs this long. Force-finalize and recover rather than staying wedged
// waiting for a stop event that may never come, for the rest of the call.
const MAX_UTTERANCE_MS = 12000;
const MIN_RMS_TO_SAMPLE = 0.01; // skip near-silence chunks
const MIN_SAMPLES_PER_UTTERANCE = 3; // ignore utterances too short to trust
// Relative deviation from the running profile before a single utterance
// counts as "doesn't match." Tuned to sit well below normal same-person
// variation (typically <15-20%) and well above a male<->female-scale shift.
const DEVIATION_THRESHOLD = 0.22;
// Require this many consecutive deviating utterances before declaring a
// new speaker — a single noisy/short utterance should never flip it alone.
const CONSECUTIVE_DEVIATIONS_REQUIRED = 2;
const PITCH_WEIGHT = 0.7;
const CENTROID_WEIGHT = 0.3;

type UtteranceFeatures = { pitchHz: number; centroidHz: number };
type SpeakerProfile = { pitchHz: number; centroidHz: number; utteranceCount: number };

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Time-domain autocorrelation pitch estimate — simple on purpose: this runs
// many times a second in the browser and only needs to be roughly right,
// not lab-grade. Returns null for silence or anything outside voice range.
function estimatePitchHz(buffer: Float32Array, sampleRate: number): number | null {
	let rms = 0;
	for (let i = 0; i < buffer.length; i++) rms += buffer[i] * buffer[i];
	rms = Math.sqrt(rms / buffer.length);
	if (rms < MIN_RMS_TO_SAMPLE) return null;

	const minLag = Math.floor(sampleRate / MAX_VOICE_HZ);
	const maxLag = Math.floor(sampleRate / MIN_VOICE_HZ);
	let bestLag = -1;
	let bestCorrelation = 0;
	for (let lag = minLag; lag <= maxLag && lag < buffer.length; lag++) {
		let correlation = 0;
		for (let i = 0; i < buffer.length - lag; i++) {
			correlation += buffer[i] * buffer[i + lag];
		}
		if (correlation > bestCorrelation) {
			bestCorrelation = correlation;
			bestLag = lag;
		}
	}
	if (bestLag <= 0) return null;
	return sampleRate / bestLag;
}

function computeSpectralCentroidHz(
	frequencyData: Uint8Array,
	sampleRate: number,
	fftSize: number
): number {
	let weightedSum = 0;
	let magnitudeSum = 0;
	for (let i = 0; i < frequencyData.length; i++) {
		const freq = (i * sampleRate) / fftSize;
		weightedSum += freq * frequencyData[i];
		magnitudeSum += frequencyData[i];
	}
	return magnitudeSum > 0 ? weightedSum / magnitudeSum : 0;
}

function relativeDeviation(a: UtteranceFeatures, profile: SpeakerProfile): number {
	const pitchDev = Math.abs(a.pitchHz - profile.pitchHz) / profile.pitchHz;
	const centroidDev =
		profile.centroidHz > 0 ? Math.abs(a.centroidHz - profile.centroidHz) / profile.centroidHz : 0;
	return PITCH_WEIGHT * pitchDev + CENTROID_WEIGHT * centroidDev;
}

// Exponential moving average — recent utterances count more, so the profile
// can drift with genuine same-person variation (tiredness, emotion) without
// needing a hard reset.
function updateProfile(profile: SpeakerProfile, next: UtteranceFeatures): SpeakerProfile {
	const alpha = profile.utteranceCount === 0 ? 1 : 0.4;
	return {
		pitchHz: profile.pitchHz * (1 - alpha) + next.pitchHz * alpha,
		centroidHz: profile.centroidHz * (1 - alpha) + next.centroidHz * alpha,
		utteranceCount: profile.utteranceCount + 1,
	};
}

export type VoiceFingerprintDebugState = {
	profile: SpeakerProfile | null;
	lastUtterance: UtteranceFeatures | null;
	lastDeviation: number | null;
	consecutiveDeviations: number;
};

export const useVoiceFingerprint = (onLikelyNewSpeaker: () => void): VoiceFingerprintDebugState => {
	const localSessionId = useLocalSessionId();
	const { persistentTrack } = useAudioTrack(localSessionId);

	const audioContextRef = useRef<AudioContext | null>(null);
	const analyserRef = useRef<AnalyserNode | null>(null);
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
	const sampleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const samplesRef = useRef<UtteranceFeatures[]>([]);
	const isSpeakingRef = useRef(false);

	const profileRef = useRef<SpeakerProfile | null>(null);
	const consecutiveDeviationsRef = useRef(0);
	const lastUtteranceRef = useRef<UtteranceFeatures | null>(null);
	const lastDeviationRef = useRef<number | null>(null);

	// Published as state (not just refs) specifically so the on-screen debug
	// panel actually re-renders when these change — refs alone don't trigger
	// renders, which would leave the panel frozen despite live audio analysis
	// happening underneath it.
	const [debugState, setDebugState] = useState<VoiceFingerprintDebugState>({
		profile: null,
		lastUtterance: null,
		lastDeviation: null,
		consecutiveDeviations: 0,
	});

	const publishDebugState = useCallback(() => {
		setDebugState({
			profile: profileRef.current,
			lastUtterance: lastUtteranceRef.current,
			lastDeviation: lastDeviationRef.current,
			consecutiveDeviations: consecutiveDeviationsRef.current,
		});
	}, []);

	const onLikelyNewSpeakerRef = useRef(onLikelyNewSpeaker);
	onLikelyNewSpeakerRef.current = onLikelyNewSpeaker;

	// Set up (and tear down) the analysis graph whenever the local mic track
	// changes — e.g. the visitor picks a different microphone mid-session.
	useEffect(() => {
		if (!persistentTrack) return;

		const audioContext = new AudioContext();
		const source = audioContext.createMediaStreamSource(new MediaStream([persistentTrack]));
		const analyser = audioContext.createAnalyser();
		analyser.fftSize = 2048;
		source.connect(analyser);

		audioContextRef.current = audioContext;
		analyserRef.current = analyser;
		sourceRef.current = source;

		return () => {
			source.disconnect();
			audioContext.close().catch(() => {});
			audioContextRef.current = null;
			analyserRef.current = null;
			sourceRef.current = null;
		};
	}, [persistentTrack]);

	const sampleOnce = useCallback(() => {
		const analyser = analyserRef.current;
		const audioContext = audioContextRef.current;
		if (!analyser || !audioContext) return;

		// Browsers can suspend an AudioContext during a long-running call
		// (power-saving, backgrounding) — a suspended context returns stale or
		// zeroed data, which would otherwise fail silently forever rather than
		// erroring. Nudge it back and skip this one sample.
		if (audioContext.state !== 'running') {
			audioContext.resume().catch(() => {});
			return;
		}

		const timeDomain = new Float32Array(analyser.fftSize);
		analyser.getFloatTimeDomainData(timeDomain);
		const pitchHz = estimatePitchHz(timeDomain, audioContext.sampleRate);
		if (pitchHz === null) return; // silence/too quiet — not a usable sample

		const frequencyData = new Uint8Array(analyser.frequencyBinCount);
		analyser.getByteFrequencyData(frequencyData);
		const centroidHz = computeSpectralCentroidHz(
			frequencyData,
			audioContext.sampleRate,
			analyser.fftSize
		);

		samplesRef.current.push({ pitchHz, centroidHz });
	}, []);

	const finalizeUtterance = useCallback(() => {
		const samples = samplesRef.current;
		samplesRef.current = [];
		if (samples.length < MIN_SAMPLES_PER_UTTERANCE) return; // too short to trust

		const utterance: UtteranceFeatures = {
			pitchHz: median(samples.map((s) => s.pitchHz)),
			centroidHz: median(samples.map((s) => s.centroidHz)),
		};
		lastUtteranceRef.current = utterance;

		const profile = profileRef.current;
		if (!profile) {
			// First utterance of a fresh session establishes the baseline —
			// nothing to compare against yet.
			profileRef.current = updateProfile(
				{ pitchHz: utterance.pitchHz, centroidHz: utterance.centroidHz, utteranceCount: 0 },
				utterance
			);
			publishDebugState();
			return;
		}

		const deviation = relativeDeviation(utterance, profile);
		lastDeviationRef.current = deviation;

		if (deviation > DEVIATION_THRESHOLD) {
			consecutiveDeviationsRef.current += 1;
			if (consecutiveDeviationsRef.current >= CONSECUTIVE_DEVIATIONS_REQUIRED) {
				// Sustained deviation, not a one-off — treat this utterance as the
				// start of a new speaker's profile and fire the callback.
				profileRef.current = updateProfile(
					{ pitchHz: utterance.pitchHz, centroidHz: utterance.centroidHz, utteranceCount: 0 },
					utterance
				);
				consecutiveDeviationsRef.current = 0;
				publishDebugState();
				onLikelyNewSpeakerRef.current();
				return;
			}
			publishDebugState();
			return;
		}

		consecutiveDeviationsRef.current = 0;
		profileRef.current = updateProfile(profile, utterance);
		publishDebugState();
	}, [publishDebugState]);

	const clearWatchdog = useCallback(() => {
		if (watchdogTimerRef.current !== null) {
			clearTimeout(watchdogTimerRef.current);
			watchdogTimerRef.current = null;
		}
	}, []);

	// Declared before start/stopSampling and populated via a ref so the
	// watchdog can call stopSampling without a circular reference between
	// the two useCallbacks.
	const stopSamplingRef = useRef<() => void>(() => {});

	const startSampling = useCallback(() => {
		if (sampleTimerRef.current !== null) return;
		samplesRef.current = [];
		sampleTimerRef.current = setInterval(sampleOnce, SAMPLE_INTERVAL_MS);
		clearWatchdog();
		watchdogTimerRef.current = setTimeout(() => {
			// No `stopped_speaking` arrived in time — force recovery instead of
			// staying wedged (see MAX_UTTERANCE_MS comment above).
			isSpeakingRef.current = false;
			stopSamplingRef.current();
		}, MAX_UTTERANCE_MS);
	}, [sampleOnce, clearWatchdog]);

	const stopSampling = useCallback(() => {
		clearWatchdog();
		if (sampleTimerRef.current !== null) {
			clearInterval(sampleTimerRef.current);
			sampleTimerRef.current = null;
		}
		finalizeUtterance();
	}, [finalizeUtterance, clearWatchdog]);

	stopSamplingRef.current = stopSampling;

	useObservableEvent<unknown>(
		useCallback(
			(event) => {
				// Prefer the canonical role-based events; the legacy
				// `conversation.user.started_speaking` variant is handled the same
				// way in case an older deployment still emits it instead.
				const isUserStarted =
					event.event_type === 'conversation.user.started_speaking' ||
					(event.event_type === 'conversation.started_speaking' &&
						event.properties.role === 'user');
				const isUserStopped =
					event.event_type === 'conversation.user.stopped_speaking' ||
					(event.event_type === 'conversation.stopped_speaking' &&
						event.properties.role === 'user');

				if (isUserStarted) {
					if (isSpeakingRef.current) {
						// A new "started speaking" while we still think the previous
						// utterance is ongoing means the matching "stopped speaking"
						// was missed or arrived out of order — treat this as proof the
						// previous utterance actually ended, finalize it, then begin
						// the new one. Without this, one missed event pair silently
						// disables detection for the rest of the call (the exact
						// "worked at first, stopped after a while" symptom found in
						// testing) since a stuck `isSpeakingRef` blocks every future
						// start from ever being noticed.
						stopSampling();
					}
					isSpeakingRef.current = true;
					startSampling();
				} else if (isUserStopped && isSpeakingRef.current) {
					isSpeakingRef.current = false;
					stopSampling();
				}
			},
			[startSampling, stopSampling]
		)
	);

	useEffect(() => {
		return () => {
			if (sampleTimerRef.current !== null) clearInterval(sampleTimerRef.current);
			clearWatchdog();
		};
	}, [clearWatchdog]);

	return debugState;
};
