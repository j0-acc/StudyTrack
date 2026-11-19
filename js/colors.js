// Deck colours. '#FFFFFF' means "No colour": the deck is shown white with a thin border.
export const NO_COLOR = '#FFFFFF';
export const COLORS = [NO_COLOR, '#FF9D2E', '#2F9BF0', '#2FBF71', '#B9A7F0', '#FF8FB1'];
export const COLOR_NAMES = {
  '#FFFFFF': 'No colour (white)', '#FF9D2E': 'Orange', '#2F9BF0': 'Blue',
  '#2FBF71': 'Green', '#B9A7F0': 'Purple', '#FF8FB1': 'Pink',
};

// a colour from the database is only used if it is a real #RRGGBB colour
export const deckColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c.toUpperCase() : NO_COLOR);
export const isPlain = (c) => deckColor(c) === NO_COLOR;

// light background for cards and chips (alpha is a 2-digit hex, e.g. '33')
export const tint = (c, alpha) => (isPlain(c) ? '#FFFFFF' : deckColor(c) + alpha);
// progress bars need something visible on white
export const barColor = (c) => (isPlain(c) ? '#C9CED6' : deckColor(c));

// paints an element with the deck's light colour; white decks get the .plain-deck border
export function paintTint(el, c, alpha) {
  el.style.background = tint(c, alpha);
  el.classList.toggle('plain-deck', isPlain(c));
}

// the round colour choices used in the Add Deck and Edit Deck popups
export function buildSwatches(box, selected) {
  box.innerHTML = '';
  const current = deckColor(selected);
  const list = COLORS.includes(current) ? COLORS : [...COLORS, current];
  list.forEach((color) => {
    const label = document.createElement('label');
    label.className = 'swatch' + (color === NO_COLOR ? ' swatch-none' : '');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'color';
    input.value = color;
    input.checked = color === current;
    input.defaultChecked = color === current;   // so form.reset() keeps a colour picked
    input.setAttribute('aria-label', COLOR_NAMES[color] || color);
    const dot = document.createElement('span');
    dot.style.background = color;
    dot.title = COLOR_NAMES[color] || color;
    label.append(input, dot);
    box.appendChild(label);
  });
}

// the picked colour, or "No colour" if somehow nothing is picked
export const pickedColor = (form) => deckColor(form.elements.color && form.elements.color.value);
