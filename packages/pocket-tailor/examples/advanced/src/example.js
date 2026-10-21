// Flagged by the synthetic strict preset, both with tailored wording.
const widget = 1;
const card = 2;

// Fine: upstream does not flag this.
export function makeHeading() {
  return "Hello";
}
