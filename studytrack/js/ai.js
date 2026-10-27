import { supabase } from './supabase.js';

// Asks the "generate-cards" function for flashcards.
// mode: 'topic' (a short topic) or 'text' (study material). Returns [{ front, back }].
export async function generateCards({ mode, input, count }) {
  const { data, error } = await supabase.functions.invoke('generate-cards', { body: { mode, input, count } });

  if (error) {
    let message = 'Could not reach the AI service. Check that the function was deployed.';
    try {
      const body = await error.context.json();
      if (body && body.error) message = body.error;
    } catch (e) { /* keep the default message */ }
    throw new Error(message);
  }
  if (data && data.error) throw new Error(data.error);
  if (!data || !Array.isArray(data.cards)) throw new Error('The AI sent back something unexpected.');
  return { cards: data.cards, truncated: Boolean(data.truncated) };
}