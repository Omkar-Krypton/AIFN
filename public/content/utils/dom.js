// Helper function to generate random delay between min and max milliseconds
function getRandomDelay(min = 1000, max = 3000) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Helper function to simulate click without any UI effect
function simulateClickWithoutEffect(element) {
  try {
    // no-op, but keep function for compatibility
    void element;
  } catch {
    // ignore
  }
}

window.getRandomDelay = getRandomDelay;
window.simulateClickWithoutEffect = simulateClickWithoutEffect;

