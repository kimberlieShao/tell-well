const questions = [
  'How are you feeling today?',
  'How do you feel right now?',
  'How’s your health today?',
  'How is your body feeling?',
  'How have you felt today?',
  'How are you doing today?',
];

// Choose locally so a varied greeting does not need another Gemini request.
// Keep this result for the whole check-in, including pauses and retries.
export function chooseCheckinOpening(previousQuestion) {
  const available = questions.filter(question => question !== previousQuestion);
  const question = available[Math.floor(Math.random() * available.length)];
  return { question, spoken: question };
}
