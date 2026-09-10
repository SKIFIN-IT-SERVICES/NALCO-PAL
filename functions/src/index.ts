import { onCall, HttpsError } from "firebase-functions/v2/https";

const TAVUS_BASE_URL = "https://tavusapi.com/v2/conversations";

function getTavusApiKey(): string {
  const key = process.env.TAVUS_API_KEY;
  if (!key) {
    throw new HttpsError(
      "failed-precondition",
      "TAVUS_API_KEY is not configured. Add it to functions/.env."
    );
  }
  return key;
}

function getTavusPalId(): string {
  const palId = process.env.TAVUS_PAL_ID;
  if (!palId) {
    throw new HttpsError(
      "failed-precondition",
      "TAVUS_PAL_ID is not configured. Add it to functions/.env."
    );
  }
  return palId;
}

export const createConversation = onCall(async (request) => {
  const conversationName: string | undefined = request.data?.conversationName;

  const response = await fetch(TAVUS_BASE_URL, {
    method: "POST",
    headers: {
      "x-api-key": getTavusApiKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pal_id: getTavusPalId(),
      conversation_name: conversationName ?? "NALCO AI Assistant",
      properties: {
        enable_closed_captions: true,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new HttpsError("internal", `Tavus API error: ${errorText}`);
  }

  const data = await response.json();
  return {
    conversationId: data.conversation_id,
    conversationUrl: data.conversation_url,
  };
});

export const endConversation = onCall(async (request) => {
  const conversationId: string | undefined = request.data?.conversationId;
  if (!conversationId) {
    throw new HttpsError("invalid-argument", "conversationId is required");
  }

  const response = await fetch(`${TAVUS_BASE_URL}/${conversationId}/end`, {
    method: "POST",
    headers: { "x-api-key": getTavusApiKey() },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new HttpsError("internal", `Tavus API error: ${errorText}`);
  }

  return { success: true };
});
