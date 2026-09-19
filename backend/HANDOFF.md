# Backend ↔ voice teammate: how to connect

Your teammate owns both the voice backend and its interface. You own the health-analysis backend requested in her document. You can build both pieces independently. The connection between them is a **transcript string** and a **JSON response**.

## Who builds what?

| Her voice backend + interface | Your health-analysis backend |
| --- | --- |
| Record button, microphone permission, recording state | Receive completed transcript text |
| ElevenLabs key, temporary tokens, speech-to-text connection | Keep the Gemini key private on your server |
| Collect the final text for one spoken turn | Use Gemini to extract facts from that text |
| Display extracted facts for review | Keep the four health arrays and the session state |
| Display/speak the follow-up question returned by the backend | Choose the next question using deterministic rules |
| Capture the user's next answer | Merge answers into the correct record item |
| Review/edit screen and Confirm button | Validate and save the confirmed record in memory |

Her voice backend should call your `/api/analyze` and forward the returned data to her interface. It should use your `nextQuestion.text`, so both pieces stay in sync. There should be one owner for health extraction and question selection: your backend.

Speaking replies with ElevenLabs **Text to Speech** belongs to her voice system. She can speak the `nextQuestion.text` your API returns. Until spoken replies are ready, her interface can display the same text.

This backend exposes only the two health API endpoints requested in the document. Voice credentials, transcription and spoken replies belong in her voice backend.

## The exact conversation loop

1. Her interface records the user's speech, and her voice backend handles the transcription connection.
2. Her system collects a completed transcript for one turn. She does not submit each interim word to your API.
3. On the first turn, her backend calls your `POST /api/analyze` with `{ transcript: completedTranscript }`.
4. Your backend returns `symptoms`, `medications`, `diet`, `vitals`, `missingFields`, and `nextQuestion`, plus `sessionId`, `version`, and `status`.
5. Her system keeps the latest response, sends the structured record to her interface, and displays or speaks the question.
6. For a spoken answer, she posts `{ sessionId, version, questionId: nextQuestion.id, transcript: answerTranscript }` to `/api/analyze`. For a button answer, use `answer: { questionId, value }` instead.
7. Replace the frontend state with every new response. Disable submission while a request is in flight. When status becomes `review`, show the final record and allow edits.
8. After the user taps Confirm, call `POST /api/checkin/save` with `{ sessionId, version, confirmed: true }`, plus the complete edited `record` if applicable.

For an unrelated new observation, omit `questionId`. An unknown answer can be skipped. A “Finish and review” button can send `action: "review"` before every missing field has been answered. See [API.md](API.md).

## Example call from her voice backend

```js
const API_BASE_URL = 'http://127.0.0.1:3001'; // Same Mac only; see device notes below.

async function sendTranscript(transcript, previousState = null) {
  const request = previousState
    ? {
        sessionId: previousState.sessionId,
        version: previousState.version,
        ...(previousState.nextQuestion
          ? { questionId: previousState.nextQuestion.id }
          : {}),
        transcript
      }
    : { transcript };

  const response = await fetch(`${API_BASE_URL}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  });
  const nextState = await response.json();
  if (!response.ok) throw new Error(nextState.error.message);
  return nextState;
}

// First turn: checkin = await sendTranscript(completedTranscript);
// Answer: checkin = await sendTranscript(answerTranscript, checkin);
// Forward checkin to the interface. Display/speak checkin.nextQuestion?.text.
// Keep a separate checkin state per user conversation, not one global variable.
```

Only pass the existing state when continuing an unsaved check-in. For more explicit action helpers, use `examples/mobile-client.ts`; its fetch calls also work in a modern Node backend. She may alternatively call your API directly from the interface if you both agree on that arrangement; keep just one owner of the session state and request flow.

## What to send your teammate

- This guide and [API.md](API.md) for requests, responses, and error handling.
- The running backend's base URL. This is separate from the GitHub repo URL.

The same-Mac address is `http://127.0.0.1:3001`. From a different computer or phone on the same trusted Wi-Fi, set `HOST=0.0.0.0` in backend `.env`, restart the server, and use the Mac's LAN IP, such as `http://192.168.1.20:3001` (replace that example IP with the real one). Keep the server and Mac running. See README for where to find the address. For a web frontend on another origin, also add that exact origin to `CORS_ORIGINS`.

These code changes are currently local on the `codex/backend` branch. The review ZIP contains a runnable copy she can unpack, or you can later share the changes through the team's Git workflow. They have not been pushed to GitHub. The API keys in `.env` are excluded; the person running the backend configures them locally. This prototype is for local tests, not a publicly exposed service.

## How you can test without waiting for voice

Open `http://127.0.0.1:3001/test/` with the server running. This small tester sends the same requests her voice code will send, using typed text. Try:

> My knees hurt more today and I forgot my prednisone this morning.

Check that it records knee pain and a missed medication, leaves the dose unknown, and asks about severity. Answer “Moderate,” then answer the activity question. Review and confirm the record. Try “I forgot the white pill” in a new check-in; the medication should stay unnamed and the backend should ask which medication it was.

The tester exercises your health extraction and question/save loop. Your teammate tests microphone capture, audio transcription, and spoken replies through her voice backend and interface. Once both parts are ready, test the combined conversation.
