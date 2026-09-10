import { useCallback, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";
import { CVIProvider } from "./components/cvi/components/cvi-provider";
import { Conversation } from "./components/cvi/components/conversation";
import "./App.css";

type CreateConversationResult = {
  conversationId: string;
  conversationUrl: string;
};

function App() {
  const [conversation, setConversation] = useState<CreateConversationResult | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exitFullscreen = useCallback(() => {
    const doc = document as Document & {
      webkitExitFullscreen?: () => Promise<void>;
    };
    if (!document.fullscreenElement) return;
    const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
    exit?.call(doc)?.catch(() => {});
  }, []);

  const startCall = useCallback(async () => {
    // Must run synchronously as the very first thing in this click handler —
    // requestFullscreen() is only honored while the browser still considers
    // this a live user gesture, which ends the moment we hit an `await`.
    const el = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void>;
    };
    const request = el.requestFullscreen ?? el.webkitRequestFullscreen;
    request?.call(el)?.catch(() => {
      // Fullscreen can be denied — the call still works without it.
    });

    setIsStarting(true);
    setError(null);
    try {
      const createConversation = httpsCallable<
        { conversationName: string },
        CreateConversationResult
      >(functions, "createConversation");
      const result = await createConversation({
        conversationName: "NALCO AI Assistant",
      });
      setConversation(result.data);
    } catch (err) {
      console.error(err);
      setError("Could not start the call. Please try again.");
    } finally {
      setIsStarting(false);
    }
  }, []);

  const endCall = useCallback(async () => {
    exitFullscreen();
    if (!conversation) return;
    const conversationId = conversation.conversationId;
    setConversation(null);
    try {
      const endConversation = httpsCallable<{ conversationId: string }, { success: boolean }>(
        functions,
        "endConversation"
      );
      await endConversation({ conversationId });
    } catch (err) {
      console.error(err);
    }
  }, [conversation, exitFullscreen]);

  return (
    // One persistent call object for the app's lifetime. Recreating it per
    // call (via a React key) was tried and reverted: the old object's async
    // teardown could still be holding the camera/mic when the new one tried
    // to acquire them, silently hanging the next join on "Connecting…".
    <CVIProvider>
      <div className="app-shell">
        {!conversation && (
          <header className="app-header">
            <span className="app-brand">NALCO</span>
            <span className="app-brand-sub">AI Assistant · एआई सहायक</span>
          </header>
        )}

        <main className={`app-main${conversation ? " app-main--call" : ""}`}>
          {!conversation ? (
            <div className="start-screen">
              <h1>Talk to the NALCO AI Assistant</h1>
              <p>Ask questions in Hindi or English and get a live video response.</p>
              {error && <p className="error-text">{error}</p>}
              <button
                type="button"
                className="start-button"
                onClick={startCall}
                disabled={isStarting}
              >
                {isStarting ? "Starting…" : "Start Call"}
              </button>
            </div>
          ) : (
            <Conversation
              conversationUrl={conversation.conversationUrl}
              onLeave={endCall}
            />
          )}
        </main>
      </div>
    </CVIProvider>
  );
}

export default App;
