// Tavus's TTS pipeline supports inline control tags in spoken text —
// `<emotion value="excited"/>`, `<lang value="hi"/>`, and similar — that
// steer delivery (facial expression, language switch) without being spoken
// aloud themselves. Tavus's own docs describe these as "meta tags that
// should be stripped before display — not spoken aloud," but the
// `conversation.utterance`/`utterance.streaming` payloads include them
// verbatim in `properties.speech`, so anything rendering that text (live
// captions, the chat transcript) needs to strip them itself.
const CONTROL_TAG_RE = /<[a-zA-Z]+\s+value="[^"]*"\s*\/>/g;

export function stripSpeechControlTags(speech: string): string {
	return speech.replace(CONTROL_TAG_RE, "").trimStart();
}
