/**
 * Live NALCO product prices for the PAL.
 *
 * NALCO does not publish a live, tick-by-tick price. It publishes a "Price
 * Circular" PDF per product family on nalcoindia.com whenever it revises
 * domestic ex-works prices (roughly every few weeks, usually all families on
 * the same date) — see https://nalcoindia.com/domestic/current-price/. There
 * is no public API, so this scrapes that page for each family's current PDF
 * link, parses the price table out of it, and caches the result in
 * Firestore.
 *
 * The PAL never scrapes anything live during a call — a scheduled job
 * refreshes the cache (see `refreshAluminiumPriceSchedule` below), and the
 * Tavus tool endpoint (`aluminiumPriceTool`) just reads that cache. This
 * keeps the in-call tool call fast and immune to nalcoindia.com being slow
 * or briefly down.
 *
 * Product families covered — chosen because their circulars are simple,
 * reliably-parseable tables (one code, one price per row):
 *   - Ingot (plain + alloy)      — grade note below
 *   - Sow Ingot
 *   - T-Ingot
 *   - Wire Rod (plain/alloy/flipped)
 *   - Billet (three prices per code, one per diameter band)
 *
 * Deliberately NOT auto-parsed: Chequered Sheet, Rolled Coil/Sheet, and Foil
 * Stock. Their circulars are multi-spec tables (alloy x temper x width x
 * length x thickness) whose PDF text extraction comes out in a jumbled,
 * non-linear order — regex-matching a price to the wrong spec row is a real
 * risk there, and a wrong number told to a visitor is worse than no number.
 * The knowledge-base summary says as much and points visitors to NALCO
 * directly for those.
 *
 * Grade note: the kiosk quotes ingot grade **IE07** by default, per explicit
 * instruction — NALCO's own circular does not use the industry-press term
 * "P1020"; that label (used by outlets like BigMint/AlCircle to describe
 * NALCO's standard-purity primary ingot) most likely corresponds to NALCO's
 * own "IC20" code, based on cross-referencing recent press-reported price
 * levels against the circular. That mapping is inferred, not confirmed by
 * NALCO directly — worth checking with NALCO's own commercial team before
 * treating it as authoritative if it's ever needed.
 */

import * as https from "https";
import * as tls from "tls";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, onRequest } from "firebase-functions/v2/https";
import { PDFParse } from "pdf-parse";
import { verifyTavusSignature } from "./tavus-tool-auth";

// nalcoindia.com's server does not send its intermediate CA certificate
// (verified independently: `openssl s_client -showcerts` against
// nalcoindia.com returns only the leaf cert, so Node's default fetch fails
// with UNABLE_TO_VERIFY_LEAF_SIGNATURE). Rather than disabling TLS
// verification for this request, the missing intermediate — RapidSSL TLS
// RSA CA G1, issued by DigiCert Global Root G2 (a root already trusted by
// Node) — is supplied explicitly so the chain still verifies genuinely.
// This is scoped to `fetchFromNalco` ONLY; every other request in this
// codebase (Tavus's API included) uses the normal, unmodified global fetch.
const RAPIDSSL_TLS_RSA_CA_G1 = `-----BEGIN CERTIFICATE-----
MIIEszCCA5ugAwIBAgIQCyWUIs7ZgSoVoE6ZUooO+jANBgkqhkiG9w0BAQsFADBh
MQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3
d3cuZGlnaWNlcnQuY29tMSAwHgYDVQQDExdEaWdpQ2VydCBHbG9iYWwgUm9vdCBH
MjAeFw0xNzExMDIxMjI0MzNaFw0yNzExMDIxMjI0MzNaMGAxCzAJBgNVBAYTAlVT
MRUwEwYDVQQKEwxEaWdpQ2VydCBJbmMxGTAXBgNVBAsTEHd3dy5kaWdpY2VydC5j
b20xHzAdBgNVBAMTFlJhcGlkU1NMIFRMUyBSU0EgQ0EgRzEwggEiMA0GCSqGSIb3
DQEBAQUAA4IBDwAwggEKAoIBAQC/uVklRBI1FuJdUEkFCuDL/I3aJQiaZ6aibRHj
ap/ap9zy1aYNrphe7YcaNwMoPsZvXDR+hNJOo9gbgOYVTPq8gXc84I75YKOHiVA4
NrJJQZ6p2sJQyqx60HkEIjzIN+1LQLfXTlpuznToOa1hyTD0yyitFyOYwURM+/CI
8FNFMpBhw22hpeAQkOOLmsqT5QZJYeik7qlvn8gfD+XdDnk3kkuuu0eG+vuyrSGr
5uX5LRhFWlv1zFQDch/EKmd163m6z/ycx/qLa9zyvILc7cQpb+k7TLra9WE17YPS
n9ANjG+ECo9PDW3N9lwhKQCNvw1gGoguyCQu7HE7BnW8eSSFAgMBAAGjggFmMIIB
YjAdBgNVHQ4EFgQUDNtsgkkPSmcKuBTuesRIUojrVjgwHwYDVR0jBBgwFoAUTiJU
IBiV5uNu5g/6+rkS7QYXjzkwDgYDVR0PAQH/BAQDAgGGMB0GA1UdJQQWMBQGCCsG
AQUFBwMBBggrBgEFBQcDAjASBgNVHRMBAf8ECDAGAQH/AgEAMDQGCCsGAQUFBwEB
BCgwJjAkBggrBgEFBQcwAYYYaHR0cDovL29jc3AuZGlnaWNlcnQuY29tMEIGA1Ud
HwQ7MDkwN6A1oDOGMWh0dHA6Ly9jcmwzLmRpZ2ljZXJ0LmNvbS9EaWdpQ2VydEds
b2JhbFJvb3RHMi5jcmwwYwYDVR0gBFwwWjA3BglghkgBhv1sAQEwKjAoBggrBgEF
BQcCARYcaHR0cHM6Ly93d3cuZGlnaWNlcnQuY29tL0NQUzALBglghkgBhv1sAQIw
CAYGZ4EMAQIBMAgGBmeBDAECAjANBgkqhkiG9w0BAQsFAAOCAQEAGUSlOb4K3Wtm
SlbmE50UYBHXM0SKXPqHMzk6XQUpCheF/4qU8aOhajsyRQFDV1ih/uPIg7YHRtFi
CTq4G+zb43X1T77nJgSOI9pq/TqCwtukZ7u9VLL3JAq3Wdy2moKLvvC8tVmRzkAe
0xQCkRKIjbBG80MSyDX/R4uYgj6ZiNT/Zg6GI6RofgqgpDdssLc0XIRQEotxIZcK
zP3pGJ9FCbMHmMLLyuBd+uCWvVcF2ogYAawufChS/PT61D9rqzPRS5I2uqa3tmIT
44JhJgWhBnFMb7AGQkvNq9KNS9dd3GWc17H/dXa1enoxzWjE0hBdFjxPhUb0W3wi
8o34/m8Fxw==
-----END CERTIFICATE-----`;

// Passing a custom `ca` list to TLS normally REPLACES Node's default trust
// store rather than extending it — concatenating `tls.rootCertificates`
// keeps every normally-trusted root trusted, and adds only the one missing
// intermediate on top.
const nalcoAgent = new https.Agent({
	ca: [...tls.rootCertificates, RAPIDSSL_TLS_RSA_CA_G1],
});

type SimpleResponse = { ok: boolean; status: number; text: () => Promise<string>; buffer: () => Promise<Buffer> };

// Node's global `fetch` (undici-based) doesn't expose a way to pass a custom
// `https.Agent`/CA list per-request, and the `undici` npm package pulled in
// for that purpose turned out to conflict with the Node 20 runtime's own
// bundled undici internals (crashed every function at container startup:
// "webidl.util.markAsUncloneable is not a function"). Node's built-in
// `https` module has no such conflict, so this uses that directly instead —
// scoped to nalcoindia.com only, one redirect hop followed, nowhere near as
// featureful as `fetch` but sufficient for plain GETs.
function fetchFromNalco(url: string, redirectsLeft = 2): Promise<SimpleResponse> {
	return new Promise((resolve, reject) => {
		https
			.get(url, { agent: nalcoAgent }, (res) => {
				const status = res.statusCode ?? 0;
				if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
					res.resume();
					resolve(fetchFromNalco(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
					return;
				}
				const chunks: Buffer[] = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					const buf = Buffer.concat(chunks);
					resolve({
						ok: status >= 200 && status < 300,
						status,
						text: async () => buf.toString("utf8"),
						buffer: async () => buf,
					});
				});
				res.on("error", reject);
			})
			.on("error", reject);
	});
}

const CURRENT_PRICE_PAGE = "https://nalcoindia.com/domestic/current-price/";
const CACHE_DOC = "metalPrices/current";
// Holds `tavusDocumentId` once the one-time knowledge-base registration
// (see `registerAluminiumKnowledgeDocument` below) has run.
const CONFIG_DOC = "metalPrices/config";
const TAVUS_DOCUMENTS_URL = "https://tavusapi.com/v2/documents";
const KNOWLEDGE_BASE_TAG = "aluminium-price";

// The grade the PAL quotes when a visitor just asks "what's the price of
// aluminium ingot" without naming a specific code.
const DEFAULT_GRADE = "IE07";

export type GradePrices = Record<string, number>;
export type BilletPrice = { d127mm: number; d152mm: number; d178to254mm: number };

export type AluminiumPriceRecord = {
	effectiveDate: string; // "YYYY-MM-DD", from the Ingot circular
	unit: "INR_PER_MT";
	grades: GradePrices; // Ingot family — kept as its own field for backward compatibility
	sowIngot: GradePrices;
	tIngot: GradePrices;
	wireRod: GradePrices;
	billet: Record<string, BilletPrice>;
	sourceUrls: Partial<Record<FamilyKey, string>>;
	fetchedAt: Timestamp | FieldValue;
};

function toIsoDate(ddMmYyyy: string): string {
	const [dd, mm, yyyy] = ddMmYyyy.split(".");
	return `${yyyy}-${mm}-${dd}`;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// `slug` must be the exact filename prefix (e.g. "Ingot", "Sow-Ingot") —
// anchoring the match on the preceding "/" is what stops "Ingot" from also
// matching "Sow-Ingot-..."/"T-Ingot-..." links on the same page.
function findPdfHref(html: string, slug: string): string | null {
	const re = new RegExp(`https?://[^"' ]*/${escapeRegex(slug)}-\\d{2}-\\d{2}-\\d{4}\\.pdf`, "i");
	return html.match(re)?.[0] ?? null;
}

async function downloadPdfText(pdfUrl: string): Promise<string> {
	const res = await fetchFromNalco(pdfUrl);
	if (!res.ok) {
		throw new Error(`Downloading ${pdfUrl} failed: HTTP ${res.status}`);
	}
	const buffer = await res.buffer();
	const parser = new PDFParse({ data: buffer });
	const { text } = await parser.getText();
	await parser.destroy();
	return text;
}

function parseEffectiveDate(text: string): string {
	const dateMatch = text.match(/w\.e\.f\.?\s*(\d{2}\.\d{2}\.\d{4})/i);
	if (!dateMatch) {
		throw new Error("Could not find the 'w.e.f DD.MM.YYYY' effective date in the circular text.");
	}
	return toIsoDate(dateMatch[1]);
}

// Row shape shared by Ingot/Sow-Ingot/T-Ingot/Wire-Rod circulars:
//   <sl.no> <description text> <CODE> <price>
// e.g. "10 ALUMINIUM INGOT IC20 367350"
function parseSimpleGradeRows(text: string, descriptionRe: string): GradePrices {
	const rowRe = new RegExp(`\\b(\\d+)\\s+${descriptionRe}\\s+([A-Z]{2}\\d{2,3})\\s+(\\d{4,7})\\b`, "g");
	const grades: GradePrices = {};
	let m: RegExpExecArray | null;
	while ((m = rowRe.exec(text)) !== null) {
		grades[m[2]] = Number(m[3]);
	}
	return grades;
}

// Billet rows carry three prices per code (one per diameter band):
//   <sl.no> ALUMINIUM BILLETS <CODE> <price@127mm> <price@152mm> <price@178-254mm>
function parseBilletRows(text: string): Record<string, BilletPrice> {
	const rowRe = /\b(\d+)\s+ALUMINIUM\s+BILLETS\s+([A-Z]{2}\d{2})\s+(\d{4,7})\s+(\d{4,7})\s+(\d{4,7})\b/g;
	const billets: Record<string, BilletPrice> = {};
	let m: RegExpExecArray | null;
	while ((m = rowRe.exec(text)) !== null) {
		billets[m[2]] = { d127mm: Number(m[3]), d152mm: Number(m[4]), d178to254mm: Number(m[5]) };
	}
	return billets;
}

type FamilyKey = "ingot" | "sowIngot" | "tIngot" | "wireRod" | "billet";

const FAMILY_SLUGS: Record<FamilyKey, string> = {
	ingot: "Ingot",
	sowIngot: "Sow-Ingot",
	tIngot: "T-Ingot",
	wireRod: "Wirerod",
	billet: "Billet",
};

// A big single-run jump is more likely a parsing error (wrong PDF, shifted
// table columns) than a real price move — refuse to cache anything that
// looks like that instead of silently feeding the PAL a bad number. Checked
// only against the Ingot family's default grade as a representative smoke
// test for "did this refresh actually work."
const MAX_PLAUSIBLE_CHANGE_FRACTION = 0.25;

async function sanityCheckAgainstPrevious(nextGrades: GradePrices): Promise<void> {
	const prevSnap = await getFirestore().doc(CACHE_DOC).get();
	if (!prevSnap.exists) return; // nothing to compare against yet
	const prev = prevSnap.data() as AluminiumPriceRecord | undefined;
	const prevPrice = prev?.grades?.[DEFAULT_GRADE];
	const nextPrice = nextGrades[DEFAULT_GRADE];
	if (!prevPrice || !nextPrice) return;

	const change = Math.abs(nextPrice - prevPrice) / prevPrice;
	if (change > MAX_PLAUSIBLE_CHANGE_FRACTION) {
		throw new Error(
			`Refusing to cache: ${DEFAULT_GRADE} moved ${(change * 100).toFixed(0)}% ` +
				`(${prevPrice} -> ${nextPrice}), which looks like a parsing error rather than a real price move.`
		);
	}
}

// Fetches and parses one product family. Ingot is required — its failure
// aborts the whole refresh (see caller). Every other family is best-effort:
// a parsing/network failure there falls back to whatever was cached
// yesterday for that family, logged but not fatal, so one page changing
// format on NALCO's site doesn't take down the families that still work.
async function refreshAluminiumPriceCore(): Promise<AluminiumPriceRecord> {
	const pageRes = await fetchFromNalco(CURRENT_PRICE_PAGE);
	if (!pageRes.ok) {
		throw new Error(`Fetching current-price page failed: HTTP ${pageRes.status}`);
	}
	const html = await pageRes.text();

	const ingotHref = findPdfHref(html, FAMILY_SLUGS.ingot);
	if (!ingotHref) {
		throw new Error("Could not find the Ingot circular link on the current-price page.");
	}
	const ingotText = await downloadPdfText(ingotHref);
	const effectiveDate = parseEffectiveDate(ingotText);
	const grades = parseSimpleGradeRows(ingotText, "ALUMINIUM(?:\\s+ALLOY)?\\s+INGOT");
	if (Object.keys(grades).length === 0) {
		throw new Error("Parsed the Ingot circular but found zero grade/price rows — layout may have changed.");
	}
	await sanityCheckAgainstPrevious(grades);

	const prevSnap = await getFirestore().doc(CACHE_DOC).get();
	const prev = prevSnap.data() as AluminiumPriceRecord | undefined;

	async function tryFamily<T>(
		key: Exclude<FamilyKey, "ingot">,
		fallback: T,
		parse: (text: string) => T
	): Promise<{ value: T; sourceUrl: string | undefined }> {
		try {
			const href = findPdfHref(html, FAMILY_SLUGS[key]);
			if (!href) throw new Error(`Could not find the ${key} circular link.`);
			const text = await downloadPdfText(href);
			const value = parse(text);
			if (value && typeof value === "object" && Object.keys(value).length === 0) {
				throw new Error(`Parsed the ${key} circular but found zero rows.`);
			}
			return { value, sourceUrl: href };
		} catch (err) {
			console.error(`Falling back to previous cached ${key} data:`, err);
			return { value: fallback, sourceUrl: prev?.sourceUrls?.[key] };
		}
	}

	const [sowIngotResult, tIngotResult, wireRodResult, billetResult] = await Promise.all([
		tryFamily("sowIngot", prev?.sowIngot ?? {}, (t) => parseSimpleGradeRows(t, "ALUMINIUM\\s+SOW\\s+INGOT")),
		tryFamily("tIngot", prev?.tIngot ?? {}, (t) => parseSimpleGradeRows(t, "ALUMINIUM\\s+T\\s*-\\s*INGOTS?")),
		tryFamily("wireRod", prev?.wireRod ?? {}, (t) =>
			parseSimpleGradeRows(t, "ALUMINIUM(?:\\s+ALLOY|\\s+FLIPPED)?\\s+WIRE\\s+RODS?")
		),
		tryFamily("billet", prev?.billet ?? {}, parseBilletRows),
	]);

	const record: AluminiumPriceRecord = {
		effectiveDate,
		unit: "INR_PER_MT",
		grades,
		sowIngot: sowIngotResult.value,
		tIngot: tIngotResult.value,
		wireRod: wireRodResult.value,
		billet: billetResult.value,
		sourceUrls: {
			ingot: ingotHref,
			sowIngot: sowIngotResult.sourceUrl,
			tIngot: tIngotResult.sourceUrl,
			wireRod: wireRodResult.sourceUrl,
			billet: billetResult.sourceUrl,
		},
		fetchedAt: FieldValue.serverTimestamp(),
	};

	await getFirestore().doc(CACHE_DOC).set(record);
	// Best-effort: the cache (used by the live tool call) is the source of
	// truth and is already updated above regardless of whether this succeeds.
	await recrawlKnowledgeDocument().catch((err) =>
		console.error("Knowledge-base recrawl threw:", err)
	);
	return record;
}

// Runs daily — NALCO revises these circulars every few weeks at most, so a
// daily check comfortably catches every revision without hammering their
// site. Scheduled in Asia/Kolkata purely so the run time is meaningful to
// whoever reads the logs; the parsing logic itself doesn't depend on it.
export const refreshAluminiumPriceSchedule = onSchedule(
	{ schedule: "0 9 * * *", timeZone: "Asia/Kolkata" },
	async () => {
		await refreshAluminiumPriceCore();
	}
);

// Manual trigger for testing and for forcing an immediate refresh right
// after NALCO issues a new circular, instead of waiting for the next
// scheduled run.
export const refreshAluminiumPriceManual = onCall(async () => {
	const record = await refreshAluminiumPriceCore();
	return { success: true, record };
});

function formatMt(price: number): string {
	const perKg = Math.round((price / 1000) * 100) / 100;
	return `Rs ${price} per tonne (Rs ${perKg} per kg)`;
}

// Plain-language summary served at `aluminiumPriceDocument` and ingested into
// Tavus's Knowledge Base — written as sentences (not a raw data dump) since
// that's what the RAG retrieval and the PAL's phrasing work best from.
function formatPriceSummaryText(record: AluminiumPriceRecord): string {
	const lines = [
		"NALCO Aluminium Product Prices (Official Domestic Price Circulars)",
		"",
		`All prices below are from NALCO's official price circulars effective ${record.effectiveDate}, ` +
			"in Indian Rupees per metric tonne, inclusive of packing charges, ex-works basic price.",
		"",
		"## Ingots (plain and alloy)",
		"",
	];
	for (const [code, price] of Object.entries(record.grades)) {
		lines.push(`- Grade ${code}: ${formatMt(price)}`);
	}
	lines.push(
		"",
		`The commonly quoted ingot grade is IE07, currently ${formatMt(record.grades[DEFAULT_GRADE])}.`
	);

	if (Object.keys(record.sowIngot).length > 0) {
		lines.push("", "## Sow Ingots", "");
		for (const [code, price] of Object.entries(record.sowIngot)) {
			lines.push(`- Grade ${code}: ${formatMt(price)}`);
		}
	}

	if (Object.keys(record.tIngot).length > 0) {
		lines.push("", "## T-Ingots", "");
		for (const [code, price] of Object.entries(record.tIngot)) {
			lines.push(`- Grade ${code}: ${formatMt(price)}`);
		}
	}

	if (Object.keys(record.wireRod).length > 0) {
		lines.push("", "## Wire Rods (plain, alloy, and flipped)", "");
		for (const [code, price] of Object.entries(record.wireRod)) {
			lines.push(`- Grade ${code}: ${formatMt(price)}`);
		}
	}

	if (Object.keys(record.billet).length > 0) {
		lines.push(
			"",
			"## Billets",
			"",
			"Billet prices vary by diameter — a smaller diameter costs more:",
			""
		);
		for (const [code, prices] of Object.entries(record.billet)) {
			lines.push(
				`- Grade ${code}: ${formatMt(prices.d127mm)} at 127mm diameter, ` +
					`${formatMt(prices.d152mm)} at 152mm, ${formatMt(prices.d178to254mm)} at 178-254mm.`
			);
		}
	}

	lines.push(
		"",
		"## Rolled products (Sheets, Coils, Foil)",
		"",
		"NALCO also sells Chequered Sheets, Rolled Coils/Sheets, and Foil Stock, but their exact " +
			"price depends on the alloy, temper, width, length, and thickness ordered, so no single " +
			"number can be quoted here. Direct visitors asking about sheet, coil, or foil pricing to " +
			"NALCO's sales team or nalcoindia.com/domestic/current-price/ for the exact specification-based price.",
		"",
		`Sources: ${Object.values(record.sourceUrls).filter(Boolean).join(", ")}`
	);
	return lines.join("\n");
}

async function recrawlKnowledgeDocument(): Promise<void> {
	const apiKey = process.env.TAVUS_API_KEY;
	if (!apiKey) {
		console.warn("Skipping knowledge-base recrawl: TAVUS_API_KEY is not configured.");
		return;
	}
	const configSnap = await getFirestore().doc(CONFIG_DOC).get();
	const documentId = configSnap.data()?.tavusDocumentId;
	if (!documentId) {
		console.warn(
			"Skipping knowledge-base recrawl: no tavusDocumentId in metalPrices/config yet — " +
				"run registerAluminiumKnowledgeDocument once to set it up."
		);
		return;
	}

	const res = await fetch(`${TAVUS_DOCUMENTS_URL}/${documentId}/recrawl`, {
		method: "POST",
		headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({ crawl: { depth: 1, max_pages: 1 } }),
	});

	if (res.status === 429) {
		// Within the 1-hour cooldown — expected if the schedule and a manual
		// refresh both ran recently. The KB still holds yesterday's content
		// until the next successful recrawl; not worth failing the whole
		// price refresh over.
		console.warn("Knowledge-base recrawl skipped: still in Tavus's cooldown window.");
		return;
	}
	if (!res.ok) {
		const errorText = await res.text();
		console.error(`Knowledge-base recrawl failed: HTTP ${res.status} ${errorText}`);
	}
}

// A stable, public, unauthenticated URL that always serves today's cached
// price as plain text. This is what Tavus's Knowledge Base actually reads —
// `create-document`/`recrawl` only accept a URL to fetch, never raw text. No
// auth needed: this is the same information NALCO already publishes openly
// on nalcoindia.com, just reformatted into sentences for RAG retrieval.
export const aluminiumPriceDocument = onRequest(async (req, res) => {
	const snap = await getFirestore().doc(CACHE_DOC).get();
	if (!snap.exists) {
		res.status(200).set("Content-Type", "text/plain").send("No price data cached yet.");
		return;
	}
	const record = snap.data() as AluminiumPriceRecord;
	res.status(200).set("Content-Type", "text/plain").send(formatPriceSummaryText(record));
});

// One-time setup: creates the Tavus Knowledge Base document pointing at
// `aluminiumPriceDocument` above, tags it, and saves the returned
// document_id into Firestore so `recrawlKnowledgeDocument` can find it on
// every subsequent daily refresh. Safe to call again — Tavus will just
// create a second document, so check `metalPrices/config` first if unsure
// whether this has already run.
export const registerAluminiumKnowledgeDocument = onCall(async () => {
	const apiKey = process.env.TAVUS_API_KEY;
	if (!apiKey) {
		throw new Error("TAVUS_API_KEY is not configured.");
	}
	const projectId = process.env.GCLOUD_PROJECT;
	const documentUrl = `https://us-central1-${projectId}.cloudfunctions.net/aluminiumPriceDocument`;

	const res = await fetch(TAVUS_DOCUMENTS_URL, {
		method: "POST",
		headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({
			document_url: documentUrl,
			document_name: "NALCO Aluminium Price (Live)",
			tags: [KNOWLEDGE_BASE_TAG],
			crawl: { depth: 1, max_pages: 1 },
		}),
	});

	if (!res.ok) {
		const errorText = await res.text();
		throw new Error(`Tavus create-document failed: HTTP ${res.status} ${errorText}`);
	}

	const data = await res.json();
	await getFirestore()
		.doc(CONFIG_DOC)
		.set({ tavusDocumentId: data.document_id, documentUrl }, { merge: true });

	return { success: true, documentId: data.document_id, documentUrl };
});

type ProductKey = "ingot" | "sow_ingot" | "t_ingot" | "wire_rod";

const PRODUCT_FIELD: Record<ProductKey, "grades" | "sowIngot" | "tIngot" | "wireRod"> = {
	ingot: "grades",
	sow_ingot: "sowIngot",
	t_ingot: "tIngot",
	wire_rod: "wireRod",
};

// The HTTPS endpoint Tavus calls when the PAL invokes the `get_aluminium_price`
// tool mid-conversation. Deliberately a raw onRequest, not onCall: Tavus
// calls this directly over HTTPS per its own tool-delivery contract, not via
// the Firebase client SDK, and authenticates itself with an HMAC signature
// instead of a Firebase Auth token.
export const aluminiumPriceTool = onRequest(async (req, res) => {
	if (req.method !== "POST") {
		res.status(405).send("Method not allowed");
		return;
	}

	// req.rawBody is populated by the Functions Framework for exactly this
	// kind of signature verification — signing must happen over the exact
	// bytes Tavus sent, not a re-serialized copy of the parsed JSON.
	const signatureHeader = req.get("X-Tavus-Signature");
	if (!verifyTavusSignature(req.rawBody, signatureHeader)) {
		res.status(401).send("Invalid signature");
		return;
	}

	let requestedGrade = DEFAULT_GRADE;
	let requestedProduct: ProductKey = "ingot";
	try {
		const argsRaw = req.body?.arguments;
		if (typeof argsRaw === "string" && argsRaw.trim()) {
			const args = JSON.parse(argsRaw);
			if (typeof args.grade === "string" && args.grade.trim()) {
				requestedGrade = args.grade.trim().toUpperCase();
			}
			if (typeof args.product === "string" && args.product.trim() in PRODUCT_FIELD) {
				requestedProduct = args.product.trim() as ProductKey;
			}
		}
	} catch {
		// Malformed arguments — fall back to the defaults rather than failing
		// the whole tool call over a JSON-parsing hiccup.
	}

	const snap = await getFirestore().doc(CACHE_DOC).get();
	if (!snap.exists) {
		res.status(200).json({
			available: false,
			message: "The latest NALCO price circular is not available right now.",
		});
		return;
	}

	const record = snap.data() as AluminiumPriceRecord;
	const gradeMap = record[PRODUCT_FIELD[requestedProduct]];
	const priceInrPerMt = gradeMap[requestedGrade];
	if (priceInrPerMt === undefined) {
		res.status(200).json({
			available: false,
			message: `No cached price for grade ${requestedGrade} under product "${requestedProduct}".`,
			knownGrades: Object.keys(gradeMap),
			otherProducts: Object.keys(PRODUCT_FIELD).filter((p) => p !== requestedProduct),
		});
		return;
	}

	res.status(200).json({
		available: true,
		product: requestedProduct,
		grade: requestedGrade,
		price_inr_per_mt: priceInrPerMt,
		price_inr_per_kg: Math.round((priceInrPerMt / 1000) * 100) / 100,
		effective_date: record.effectiveDate,
		source: "NALCO official domestic price circular (nalcoindia.com)",
		other_products_available: Object.keys(PRODUCT_FIELD).filter((p) => p !== requestedProduct),
		note:
			"Billets and rolled products (sheets/coils/foil) are not covered by this tool — billets " +
			"vary by diameter and rolled products by alloy/temper/thickness. Refer visitors to " +
			"nalcoindia.com or NALCO sales for those.",
	});
});
