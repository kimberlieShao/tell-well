# Records page: data format

The Records page (a month calendar, with a dialog for each day) shows a list of **saved check-ins**.
It uses the backend's own field names, so example data and real data look the same to the screen.
Nothing new is invented here: a check-in is `sessionId` + `savedAt` from the saved check-in response,
plus the record itself. The full rules are in
[backend/contracts/record.schema.json](backend/contracts/record.schema.json) and
[backend/src/schema.ts](backend/src/schema.ts).

## Where it comes from

The page reads `GET /api/records`, which returns
`{ "source": "demo" | "real", "name": ..., "checkins": [...], "quietDays": [...] }`.
While the demo switch (top bar) is on, that is the example person from
[backend/demo-data/arthur-itis.json](backend/demo-data/arthur-itis.json); otherwise it is the person's own
confirmed check-ins, which the server keeps in memory until it restarts. The `checkins` list has the shape below.
`quietDays` is described under "Quiet days" below; it is `[]` for real data.
The page reads it again each time the Records tab is opened. Turning the demo switch on or off reloads the page
and comes back to Records.

## Shape

One JSON object with a `checkins` array. The order does not matter (the page sorts by `savedAt`).
One check-in is one time the person finished a check-in; a day can have several.

```json
{
  "checkins": [
    {
      "sessionId": "b7d3c1a2-4e5f-4a6b-8c7d-0e1f2a3b4c5d",
      "savedAt": "2026-09-19T12:30:00Z",
      "symptoms": [
        {
          "id": "c1000000-0000-4000-8000-000000000001",
          "name": "Headache",
          "location": "Behind the eyes",
          "severity": "moderate",
          "severityScore": 6,
          "trend": "worse",
          "functionalImpact": "Bright light bothers me",
          "duration": "Since yesterday afternoon",
          "firstOccurrence": false
        }
      ],
      "medications": [
        {
          "id": "c2000000-0000-4000-8000-000000000001",
          "name": "Ibuprofen",
          "description": "For the headache",
          "dose": "200 mg",
          "status": "taken",
          "time": "Morning"
        }
      ],
      "diet": [
        {
          "id": "c3000000-0000-4000-8000-000000000001",
          "description": "Toast and tea",
          "time": "Breakfast",
          "waterGlasses": 2,
          "waterMode": "total"
        }
      ],
      "vitals": [
        {
          "id": "c4000000-0000-4000-8000-000000000001",
          "name": "Blood pressure",
          "value": "128/82",
          "unit": "mmHg",
          "time": "8:20 am"
        }
      ],
      "wellness": null,
      "reportedAnswers": [
        {
          "questionId": null,
          "entityId": null,
          "field": null,
          "question": null,
          "transcript": "My headache is back and it is worse than yesterday.",
          "interpretation": "recorded"
        },
        {
          "questionId": "c1000000-0000-4000-8000-000000000001:duration",
          "entityId": "c1000000-0000-4000-8000-000000000001",
          "field": "duration",
          "question": "When did the headache start?",
          "transcript": "Yesterday afternoon, after lunch.",
          "interpretation": "recorded"
        }
      ]
    }
  ]
}
```

## Fields

**Check-in**

| Field | Meaning |
|---|---|
| `sessionId` | A UUID, unique per check-in. |
| `savedAt` | When it was saved, as UTC with a trailing `Z` (as the backend writes it). It decides which day the check-in appears on, using the viewer's local time zone, so avoid times near midnight. |
| `symptoms`, `medications`, `diet` | The lists shown in the day dialog. Use `[]` when there are none. |
| `vitals` | Readings such as blood pressure, shown under "Vitals". See below. |
| `wellness` | For a "felt well" day: `{ "status": "well", "statement": "I feel fine today." }`, else `null`. The statement is shown as one line at the top of the day. |
| `reportedAnswers` | What the person said, in their own words. See below. |

A day gets a dot on the calendar when it has at least one check-in with something to show
(a symptom, medication, diet item, a vital with a value, wellness statement or reported answer).
The dot is **red** ("pain recorded") when any symptom that day has a score other than 0, or no score at all,
and **green** ("no pain reported") when the day has data but no such symptom, for example a "good day"
wellness check-in, or only medications and blood pressure. Days with nothing have no dot. Each day's
accessible label says the same in words, e.g. `September 18, 2026, pain recorded`.

**Symptom** (`symptoms[]`)

| Field | Shown as | Values |
|---|---|---|
| `id` | not shown; links `reportedAnswers` to this row | UUID |
| `name` | the row title | text |
| `severityScore` | Pain level, as `6/10` | number 0–10 |
| `severity` | Pain level, as a word (added to the score if both exist) | `mild`, `moderate`, `severe` |
| `location` | Location | text |
| `duration` | Since when | text, e.g. `"3 days"` |
| `functionalImpact` | Activities affected | text |
| `trend` | Trend | `better`, `same`, `worse` |
| `firstOccurrence` | First time (`Yes` / `No`) | `true`, `false` |

**Medication** (`medications[]`)

| Field | Shown as | Values |
|---|---|---|
| `id` | not shown | UUID |
| `name` | the row title | text |
| `status` | Status | `taken`, `missed`, `stopped`, `mentioned` |
| `description` | Purpose, what it is for | text |
| `dose` | Dose | text, e.g. `"200 mg"` |
| `time` | Time | text, e.g. `"Morning"` |

**Diet** (`diet[]`, shown under "Meals")

| Field | Shown as | Values |
|---|---|---|
| `id` | not shown | UUID |
| `description` | the row title | text |
| `time` | Time | text, e.g. `"Lunch"` |
| `waterGlasses` | Water | number |
| `waterMode` | `total` adds "in total today" to the water line | `add`, `total` |

**Vital** (`vitals[]`, shown under "Vitals" as `Blood pressure: 128/82 mmHg`)

| Field | Shown as | Values |
|---|---|---|
| `id` | not shown; links `reportedAnswers` to this row | UUID |
| `name` | the start of the row, before the colon | text, e.g. `"Blood pressure"` |
| `value` | the reading. A vital with no value is left out. | text, e.g. `"128/82"` |
| `unit` | after the value | text, e.g. `"mmHg"` |
| `time` | Time | text, e.g. `"8:20 am"` |

**Reported answer** (`reportedAnswers[]`, shown as "In your own words")

| Field | Meaning |
|---|---|
| `transcript` | The person's own words. This is what is shown. |
| `entityId` | The `id` of the symptom, medication, diet item or vital they were talking about. The quote appears inside that row. `null` means it is not about one item, such as the opening description. It is then listed under "In your own words" at the bottom of the day. |
| `question` | The question they were answering, shown above the quote. `null` if there was none. |
| `interpretation` | `recorded` or `unconfirmed`. An unconfirmed answer gets a small "not confirmed" note. |
| `questionId`, `field` | Not shown. Keep them as in the schema (`null` when not needed). |

## Quiet days (optional)

`quietDays` lists days that have a short daily reading but no check-in. Only the example person has them
(they are what the Trends charts draw for the days between check-ins). Each one:

```json
{ "date": "2026-08-26", "pain": 2, "systolic": 121, "diastolic": 77, "taken": 1, "due": 1, "note": "Mild stiffness" }
```

| Field | Meaning |
|---|---|
| `date` | The local day, `YYYY-MM-DD`. |
| `pain` | Pain that day, 0–10, or `null`. Above 0 gives a red dot; 0 or `null` gives a green dot. |
| `systolic`, `diastolic` | Blood pressure, or `null`. Shown as `Blood pressure: 121/77 mmHg`. |
| `taken`, `due` | Doses taken and doses due that day. Shown as `Doses taken: 1 of 1` when `due` is above 0. |
| `note` | A few words, such as `Mild stiffness`. `No symptoms reported` is not repeated in the dialog. |

The day dialog for a quiet day opens with `Quiet day · no pain reported` (or `Quiet day · pain 2/10`),
followed by the same groups as any other day: Symptoms (only when pain is above 0), Medications and Vitals.
If a day has both a check-in and a quiet-day reading, the check-in is what is shown.

Wearable nights (`nights` in the demo file: heart rate, sleep and so on) are not records and get no dot.

## Missing values

Only fields that have a value are shown. `null` or an absent field is simply left out of the row, and a row
with nothing to expand cannot be opened. Fields the page does not know are ignored. Even so, keep the data
valid against the schema; the checks below rely on it.

## Checking the data

`backend/test/records-api.test.ts` checks that `/api/records` returns valid records for both the example person and
real saved check-ins, and `backend/test/records-ui.test.ts` checks that the example in this file passes the
backend's `recordSchema`. To check a JSON file of your own the same way, run from `backend/`:

```sh
node --import tsx -e "import('./src/schema.ts').then(async ({recordSchema})=>{const {checkins}=JSON.parse(await (await import('node:fs/promises')).readFile(process.argv[1],'utf8'));for(const c of checkins){const {sessionId,savedAt,...record}=c;recordSchema.parse(record)}console.log(checkins.length,'check-ins OK')})" path/to/records.json
```
