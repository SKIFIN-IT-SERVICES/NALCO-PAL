/**
 * The prize quiz — voice-answered, per the engagement plan's Section 5
 * Feature 3, the decisions locked in Section 11, and live-testing feedback:
 *
 *   - Answered by voice ("option B"), not by tapping a card.
 *   - The backend holds the answer key and does ALL scoring. The PAL never
 *     receives a correct answer — only "matched: true/false, correct:
 *     true/false" — so it physically cannot leak it, hint at it, or be
 *     talked into revealing one early.
 *   - The backend counts questions and score, not the PAL — language models
 *     are unreliable at counting, and with a prize attached that becomes an
 *     argument.
 *   - FIVE DIFFERENT QUESTIONS, ONE ATTEMPT EACH — not one question
 *     repeated up to five times. Live testing found that format felt wrong:
 *     five guesses at a four-option question isn't testing knowledge, it's
 *     just attrition until the visitor stumbles onto the right one. A real
 *     quiz round is the fix, and the plan's Section 5 already flagged this
 *     exact alternative ("five different questions with one attempt each").
 *   - Prize tier depends on the FINAL SCORE out of 5, not on which attempt
 *     succeeded (that concept no longer applies with one try per question):
 *     5/5 = top prize, 3-4/5 = a prize, 1-2/5 = a small prize, 0/5 = no
 *     prize, but the PAL reads out the questions they missed so the visitor
 *     still leaves having learned something.
 *   - A mis-heard answer ("option B" heard as "option D") must never
 *     silently consume the one attempt for that question — if nothing
 *     matches confidently, the backend says so and re-serves the SAME
 *     question, and the PAL is expected to ask again.
 *
 * Prize code issuance/redemption reuses the exact atomic transaction shape
 * already proven in otp-gate.ts: read-check-write in one transaction, so
 * two staff members scanning the same code at the same instant cannot both
 * redeem it.
 *
 * QUESTION BANK NOTE: the questions seeded below are clearly-marked
 * PLACEHOLDER content for testing this engine end-to-end. Per the plan's
 * explicit warning, real questions must be written and approved by NALCO
 * before this runs at an actual event — an AI-invented "correct" answer
 * attached to a real prize is a public argument waiting to happen.
 */

import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { verifyTavusSignature, parseToolArguments } from "./tavus-tool-auth";

type Language = "en" | "hi";

type QuizOption = { id: string; text_en: string; text_hi: string };

type QuizQuestion = {
	text_en: string;
	text_hi: string;
	options: QuizOption[];
	correctOptionId: string;
	difficulty: "easy" | "medium" | "hard";
	approved: boolean;
};

// A question as locked into a session — a snapshot taken at start_quiz time,
// so a mid-quiz change to the question bank can never affect an in-progress
// session, and submit_quiz_answer never needs to re-fetch anything.
type SessionQuestion = {
	text_en: string;
	text_hi: string;
	options: QuizOption[];
	correctOptionId: string;
};

const QUESTIONS_PER_QUIZ = 5;

type PrizeTier = "perfect_score" | "high_score" | "some_correct";

const PRIZE_TIER_LABELS: Record<PrizeTier, { en: string; hi: string }> = {
	perfect_score: { en: "top prize", hi: "सबसे बड़ा इनाम" },
	high_score: { en: "prize", hi: "इनाम" },
	some_correct: { en: "small prize", hi: "छोटा इनाम" },
};

// 0 correct wins nothing (PrizeTier stays null) — the PAL instead reads out
// what they missed, so there is still something positive to leave with.
function tierForScore(correctCount: number): PrizeTier | null {
	if (correctCount === QUESTIONS_PER_QUIZ) return "perfect_score";
	if (correctCount >= 3) return "high_score";
	if (correctCount >= 1) return "some_correct";
	return null;
}

// Six-character, unambiguous-alphabet prize code — avoids 0/O and 1/I/L,
// which staff would otherwise have to squint at when checking a code by eye.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generatePrizeCode(): string {
	let code = "";
	for (let i = 0; i < 6; i++) {
		code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
	}
	return code;
}

// Matches a free-text spoken answer ("option B", "b", or the option's own
// content like "Panchpatmali") against the current question's option list.
// Returns null on no confident match — the caller must NOT advance to the
// next question or touch the score; a mis-heard answer costs nothing and
// the same question is re-served.
function matchOptionId(answer: string, options: QuizOption[]): string | null {
	const normalized = answer.toLowerCase().trim();
	if (!normalized) return null;

	const letterMatch = normalized.match(/\b([a-d])\b/);
	if (letterMatch) {
		const byLetter = options.find((o) => o.id.toLowerCase() === letterMatch[1]);
		if (byLetter) return byLetter.id;
	}

	let best: { id: string; score: number } | null = null;
	for (const opt of options) {
		const words = `${opt.text_en} ${opt.text_hi}`
			.toLowerCase()
			.split(/[^a-zऀ-ॿ]+/)
			.filter((w) => w.length >= 4);
		let score = 0;
		for (const w of words) {
			if (normalized.includes(w)) score++;
		}
		if (score > 0 && (!best || score > best.score)) {
			best = { id: opt.id, score };
		}
	}
	return best?.id ?? null;
}

function localize(text_en: string, text_hi: string, language: Language): string {
	return language === "hi" ? text_hi : text_en;
}

type WrongAnswerRecord = { question: string; correctAnswer: string };

type QuizSession = {
	conversationId: string;
	visitorName: string;
	language: Language;
	questions: SessionQuestion[]; // exactly QUESTIONS_PER_QUIZ, snapshotted at start
	currentIndex: number; // 0-based index into `questions`
	correctCount: number;
	wrongAnswers: WrongAnswerRecord[]; // localized text, built up as they go — read back only on a 0-score finish
	status: "in_progress" | "completed";
	wonTier: PrizeTier | null;
	prizeCode: string | null;
	createdAt: Timestamp | FieldValue;
	updatedAt: Timestamp | FieldValue;
};

const PLACEHOLDER_QUESTIONS: QuizQuestion[] = [
	{
		text_en: "Where are NALCO's bauxite mines located?",
		text_hi: "नाल्को की बॉक्साइट खदानें कहाँ स्थित हैं?",
		options: [
			{ id: "a", text_en: "Panchpatmali, Koraput", text_hi: "पंचपटमाली, कोरापुट" },
			{ id: "b", text_en: "Angul", text_hi: "अंगुल" },
			{ id: "c", text_en: "Bhubaneswar", text_hi: "भुवनेश्वर" },
			{ id: "d", text_en: "Visakhapatnam", text_hi: "विशाखापत्तनम" },
		],
		correctOptionId: "a",
		difficulty: "easy",
		approved: true,
	},
	{
		text_en: "Which year was NALCO founded?",
		text_hi: "नाल्को की स्थापना किस वर्ष हुई थी?",
		options: [
			{ id: "a", text_en: "1975", text_hi: "1975" },
			{ id: "b", text_en: "1981", text_hi: "1981" },
			{ id: "c", text_en: "1990", text_hi: "1990" },
			{ id: "d", text_en: "2000", text_hi: "2000" },
		],
		correctOptionId: "b",
		difficulty: "easy",
		approved: true,
	},
	{
		text_en: "NALCO's aluminium smelter and captive power plant are located at:",
		text_hi: "नाल्को का एल्युमिनियम स्मेल्टर और कैप्टिव पावर प्लांट कहाँ स्थित है?",
		options: [
			{ id: "a", text_en: "Damanjodi", text_hi: "दामनजोड़ी" },
			{ id: "b", text_en: "Koraput", text_hi: "कोरापुट" },
			{ id: "c", text_en: "Angul", text_hi: "अंगुल" },
			{ id: "d", text_en: "Rourkela", text_hi: "राउरकेला" },
		],
		correctOptionId: "c",
		difficulty: "easy",
		approved: true,
	},
	{
		text_en: "What category of public sector company is NALCO?",
		text_hi: "नाल्को किस श्रेणी की सार्वजनिक क्षेत्र की कंपनी है?",
		options: [
			{ id: "a", text_en: "Maharatna", text_hi: "महारत्न" },
			{ id: "b", text_en: "Navratna", text_hi: "नवरत्न" },
			{ id: "c", text_en: "Miniratna", text_hi: "मिनीरत्न" },
			{ id: "d", text_en: "Private Limited", text_hi: "प्राइवेट लिमिटेड" },
		],
		correctOptionId: "b",
		difficulty: "medium",
		approved: true,
	},
	{
		text_en: "Which raw material is refined into alumina before becoming aluminium?",
		text_hi: "एल्युमिनियम बनने से पहले किस कच्चे माल को एल्युमिना में परिष्कृत किया जाता है?",
		options: [
			{ id: "a", text_en: "Iron ore", text_hi: "लौह अयस्क" },
			{ id: "b", text_en: "Limestone", text_hi: "चूना पत्थर" },
			{ id: "c", text_en: "Bauxite", text_hi: "बॉक्साइट" },
			{ id: "d", text_en: "Coal", text_hi: "कोयला" },
		],
		correctOptionId: "c",
		difficulty: "easy",
		approved: true,
	},
	{
		text_en: "What is NALCO's corporate headquarters city?",
		text_hi: "नाल्को का कॉर्पोरेट मुख्यालय किस शहर में है?",
		options: [
			{ id: "a", text_en: "Bhubaneswar", text_hi: "भुवनेश्वर" },
			{ id: "b", text_en: "Cuttack", text_hi: "कटक" },
			{ id: "c", text_en: "Puri", text_hi: "पुरी" },
			{ id: "d", text_en: "Rourkela", text_hi: "राउरकेला" },
		],
		correctOptionId: "a",
		difficulty: "medium",
		approved: true,
	},
	{
		text_en: "Which process converts bauxite into alumina?",
		text_hi: "बॉक्साइट को एल्युमिना में बदलने की प्रक्रिया कौन सी है?",
		options: [
			{ id: "a", text_en: "Hall-Héroult process", text_hi: "हॉल-हेरॉल्ट प्रक्रिया" },
			{ id: "b", text_en: "Bayer process", text_hi: "बेयर प्रक्रिया" },
			{ id: "c", text_en: "Haber process", text_hi: "हैबर प्रक्रिया" },
			{ id: "d", text_en: "Solvay process", text_hi: "सॉल्वे प्रक्रिया" },
		],
		correctOptionId: "b",
		difficulty: "hard",
		approved: true,
	},
];

export const seedQuizQuestions = onCall(async () => {
	const db = getFirestore();
	const batch = db.batch();
	for (const q of PLACEHOLDER_QUESTIONS) {
		const ref = db.collection("quizQuestions").doc();
		batch.set(ref, q);
	}
	await batch.commit();
	return { success: true, seeded: PLACEHOLDER_QUESTIONS.length };
});

// Picks QUESTIONS_PER_QUIZ distinct approved questions at random (a simple
// Fisher-Yates-style partial shuffle) — never the same question twice in
// one quiz. Returns fewer than QUESTIONS_PER_QUIZ if the bank is smaller
// than that; the caller runs the quiz with however many are available
// rather than failing outright.
async function pickQuizQuestions(): Promise<SessionQuestion[]> {
	const snap = await getFirestore().collection("quizQuestions").where("approved", "==", true).get();
	const pool = snap.docs.map((d) => d.data() as QuizQuestion);
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[pool[i], pool[j]] = [pool[j], pool[i]];
	}
	return pool.slice(0, QUESTIONS_PER_QUIZ).map((q) => ({
		text_en: q.text_en,
		text_hi: q.text_hi,
		options: q.options,
		correctOptionId: q.correctOptionId,
	}));
}

function sessionRef(conversationId: string) {
	return getFirestore().collection("quizSessions").doc(conversationId);
}

function questionPayload(session: QuizSession, question: SessionQuestion) {
	return {
		question: localize(question.text_en, question.text_hi, session.language),
		options: question.options.map((o) => ({
			id: o.id,
			text: localize(o.text_en, o.text_hi, session.language),
		})),
		question_number: session.currentIndex + 1,
		total_questions: session.questions.length,
	};
}

// The HTTPS endpoint Tavus calls for the `start_quiz` tool.
export const startQuizTool = onRequest(async (req, res) => {
	if (req.method !== "POST") {
		res.status(405).send("Method not allowed");
		return;
	}
	const signatureHeader = req.get("X-Tavus-Signature");
	if (!verifyTavusSignature(req.rawBody, signatureHeader)) {
		res.status(401).send("Invalid signature");
		return;
	}

	const conversationId: string | undefined = req.body?.conversation_id;
	if (!conversationId) {
		res.status(200).json({ available: false, message: "Missing conversation id." });
		return;
	}

	const args = parseToolArguments(req.body?.arguments);
	const visitorName = typeof args.visitor_name === "string" ? args.visitor_name.trim() : "";
	const language: Language = args.language === "hi" ? "hi" : "en";

	if (!visitorName) {
		res.status(200).json({
			available: false,
			message: "No visitor name was given. Ask for their name before starting the quiz.",
		});
		return;
	}

	const questions = await pickQuizQuestions();
	if (questions.length === 0) {
		res.status(200).json({
			available: false,
			message: "No quiz questions are configured right now.",
		});
		return;
	}

	const session: QuizSession = {
		conversationId,
		visitorName,
		language,
		questions,
		currentIndex: 0,
		correctCount: 0,
		wrongAnswers: [],
		status: "in_progress",
		wonTier: null,
		prizeCode: null,
		createdAt: FieldValue.serverTimestamp(),
		updatedAt: FieldValue.serverTimestamp(),
	};
	await sessionRef(conversationId).set(session);

	res.status(200).json({
		available: true,
		visitor_name: visitorName,
		...questionPayload(session, questions[0]),
	});
});

// The HTTPS endpoint Tavus calls for the `submit_quiz_answer` tool.
export const submitQuizAnswerTool = onRequest(async (req, res) => {
	if (req.method !== "POST") {
		res.status(405).send("Method not allowed");
		return;
	}
	const signatureHeader = req.get("X-Tavus-Signature");
	if (!verifyTavusSignature(req.rawBody, signatureHeader)) {
		res.status(401).send("Invalid signature");
		return;
	}

	const conversationId: string | undefined = req.body?.conversation_id;
	if (!conversationId) {
		res.status(200).json({ matched: false, message: "Missing conversation id." });
		return;
	}

	const args = parseToolArguments(req.body?.arguments);
	const rawAnswer = typeof args.answer === "string" ? args.answer : "";

	const snap = await sessionRef(conversationId).get();
	if (!snap.exists) {
		res.status(200).json({
			matched: false,
			message: "No quiz is running for this conversation. Call start_quiz first.",
		});
		return;
	}
	const session = snap.data() as QuizSession;
	if (session.status !== "in_progress") {
		res.status(200).json({
			matched: false,
			message: `The quiz already finished. Call start_quiz again if the visitor wants another round.`,
		});
		return;
	}

	const currentQuestion = session.questions[session.currentIndex];
	const matchedOptionId = matchOptionId(rawAnswer, currentQuestion.options);
	if (!matchedOptionId) {
		// Deliberately does NOT advance currentIndex or touch the score — a
		// mis-heard or unclear answer must never cost the visitor this
		// question; the same one is re-served below.
		res.status(200).json({
			matched: false,
			message: "Could not confidently match that to one of the options. Ask the visitor to repeat their answer, e.g. by saying the option letter.",
			...questionPayload(session, currentQuestion),
		});
		return;
	}

	const isCorrect = matchedOptionId === currentQuestion.correctOptionId;
	const correctOption = currentQuestion.options.find((o) => o.id === currentQuestion.correctOptionId);
	const correctAnswerText = correctOption
		? localize(correctOption.text_en, correctOption.text_hi, session.language)
		: currentQuestion.correctOptionId;

	const nextCorrectCount = session.correctCount + (isCorrect ? 1 : 0);
	const nextWrongAnswers = isCorrect
		? session.wrongAnswers
		: [
				...session.wrongAnswers,
				{
					question: localize(currentQuestion.text_en, currentQuestion.text_hi, session.language),
					correctAnswer: correctAnswerText,
				},
			];
	const nextIndex = session.currentIndex + 1;
	const isLastQuestion = nextIndex >= session.questions.length;

	if (!isLastQuestion) {
		await sessionRef(conversationId).update({
			currentIndex: nextIndex,
			correctCount: nextCorrectCount,
			wrongAnswers: nextWrongAnswers,
			updatedAt: FieldValue.serverTimestamp(),
		});
		const nextSession: QuizSession = { ...session, currentIndex: nextIndex };
		res.status(200).json({
			matched: true,
			correct: isCorrect,
			quiz_complete: false,
			message: isCorrect
				? "Correct! Briefly congratulate them, then read the next question."
				: "Incorrect — do not reveal the correct answer now. Briefly acknowledge and move to the next question.",
			...questionPayload(nextSession, session.questions[nextIndex]),
		});
		return;
	}

	// Last question just answered — finish the quiz and score it.
	const tier = tierForScore(nextCorrectCount);
	let prizeCode: string | null = null;
	if (tier) {
		prizeCode = generatePrizeCode();
		await getFirestore()
			.collection("prizeCodes")
			.doc(prizeCode)
			.set({
				tier,
				visitorName: session.visitorName,
				conversationId,
				score: nextCorrectCount,
				totalQuestions: session.questions.length,
				issuedAt: FieldValue.serverTimestamp(),
				redeemed: false,
			});
	}

	await sessionRef(conversationId).update({
		currentIndex: nextIndex,
		correctCount: nextCorrectCount,
		wrongAnswers: nextWrongAnswers,
		status: "completed",
		wonTier: tier,
		prizeCode,
		updatedAt: FieldValue.serverTimestamp(),
	});

	if (tier && prizeCode) {
		const tierLabel = PRIZE_TIER_LABELS[tier][session.language];
		res.status(200).json({
			matched: true,
			correct: isCorrect,
			quiz_complete: true,
			score: nextCorrectCount,
			total_questions: session.questions.length,
			tier,
			tier_label: tierLabel,
			prize_code: prizeCode,
			message: `Quiz finished: ${nextCorrectCount}/${session.questions.length} correct. Immediately call celebrate_win with visitor_name="${session.visitorName}", tier_label="${tierLabel}", and prize_code="${prizeCode}" so the screen shows their win. Then congratulate them aloud and tell them to show that screen to a NALCO team member.`,
		});
		return;
	}

	// 0 correct: no prize, but give them something — read back what they
	// missed, phrased kindly, rather than just ending flatly.
	res.status(200).json({
		matched: true,
		correct: isCorrect,
		quiz_complete: true,
		score: 0,
		total_questions: session.questions.length,
		tier: null,
		wrong_answers: nextWrongAnswers,
		message: `Quiz finished: 0/${session.questions.length} correct — no prize this time. Kindly go through each question in wrong_answers and state the correct answer, then encourage them to try again another day. Do not call celebrate_win.`,
	});
});

// Staff-facing: checks a prize code and marks it redeemed, atomically —
// identical shape to redeemOtp in otp-gate.ts, so two staff members
// checking the same code at the same instant cannot both redeem it.
export const redeemPrizeCode = onCall(async (request) => {
	const code: string | undefined = request.data?.code;
	if (!code) {
		throw new HttpsError("invalid-argument", "code is required");
	}
	const normalizedCode = code.trim().toUpperCase();
	const ref = getFirestore().collection("prizeCodes").doc(normalizedCode);

	try {
		const result = await getFirestore().runTransaction(async (tx) => {
			const doc = await tx.get(ref);
			if (!doc.exists) {
				throw new HttpsError("not-found", "That code was not found.");
			}
			const data = doc.data()!;
			if (data.redeemed === true) {
				throw new HttpsError("failed-precondition", "That code was already redeemed.");
			}
			tx.update(ref, { redeemed: true, redeemedAt: FieldValue.serverTimestamp() });
			return { tier: data.tier, visitorName: data.visitorName, score: data.score, totalQuestions: data.totalQuestions };
		});
		return { success: true, ...result };
	} catch (err) {
		if (err instanceof HttpsError) throw err;
		throw new HttpsError("internal", "Could not redeem the code. Try again.");
	}
});
