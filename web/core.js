/** Preserve the user's intentional newline boundaries. Ignore blank lines, never punctuation-split. */
export function splitPracticeLines(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
}
export const STARTER_TEXT = 'I thought it would be easier.\nCould you say that one more time?\nI really want to improve my pronunciation.\nWe can figure it out as we go along.';
export const VOICES = [
  ['aiden', 'Aiden', 'Clear American male (recommended)'],
  ['ryan', 'Ryan', 'English-speaking male; accent not guaranteed'],
  ['serena', 'Serena', 'Expressive female'],
  ['vivian', 'Vivian', 'Expressive female'],
  ['dylan', 'Dylan', 'Male, Chinese background'],
  ['eric', 'Eric', 'Male, Chinese background'],
  ['sohee', 'Sohee', 'Female, Korean background'],
  ['ono_anna', 'Ono Anna', 'Female, Japanese background'],
  ['uncle_fu', 'Uncle Fu', 'Male, Chinese background'],
];
export const MODEL_CHOICES = [
  { id: 'qwen3-tts-0.6b', name: 'Qwen3-TTS 0.6B', size: '1.21 GB', detail: 'Recommended · smaller and lighter (Q8_0)' },
  { id: 'qwen3-tts-1.7b', name: 'Qwen3-TTS 1.7B', size: '2.29 GB', detail: 'Larger model · requires more memory (Q8_0)' },
];
