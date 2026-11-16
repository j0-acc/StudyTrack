import { supabase } from './supabase.js';

// Calls the "generate-cards" function and turns any problem into a readable error.
async function callAI(body) {
  const { data, error } = await supabase.functions.invoke('generate-cards', { body });
  if (error) {
    // no internet (the request never reached the server): let the page keep the work for later
    if (error.name === 'FunctionsFetchError' || !navigator.onLine) throw new Error('Failed to fetch (offline)');
    let message = 'Could not reach the AI service. Check that the function was deployed.';
    try {
      const reply = await error.context.json();
      if (reply && reply.error) message = reply.error;
    } catch (e) { /* keep the default message */ }
    throw new Error(message);
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

// Asks for flashcards. mode: 'topic' (a short topic) or 'text' (study material). Returns [{ front, back }].
export async function generateCards({ mode, input, count }) {
  const data = await callAI({ mode, input, count });
  if (!data || !Array.isArray(data.cards)) throw new Error('The AI sent back something unexpected.');
  return { cards: data.cards, truncated: Boolean(data.truncated) };
}

// Reads the text on scanned PDF pages. images: [{ mime, data (base64) }]. Returns the text.
export async function readScannedPages(images) {
  const data = await callAI({ mode: 'read', images: images.map(({ mime, data: d }) => ({ mime, data: d })) });
  return String((data && data.text) || '').trim();
}
