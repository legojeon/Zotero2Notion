const switcher = document.querySelector(".language-switch");
const sections = [...document.querySelectorAll("main section[id], main article[id]")];

function setLanguageAnchor(hash) {
  for (const link of switcher.querySelectorAll("a")) {
    link.hash = hash;
  }
}

function useReadingPosition() {
  const headerBottom = switcher.closest("header").getBoundingClientRect().bottom;
  const selected = sections.find(section => "#" + section.id === location.hash);
  const bounds = selected?.getBoundingClientRect();
  // A short last section may be visible without reaching the top of the viewport.
  if (bounds && bounds.bottom > headerBottom && bounds.top < window.innerHeight) {
    setLanguageAnchor(location.hash);
    return;
  }
  const readingLine = Math.max(headerBottom + 24, window.innerHeight / 3);
  const current = sections.findLast(section => section.getBoundingClientRect().top <= readingLine);
  setLanguageAnchor(current?.id || "");
}

function useLinkedPosition() {
  setLanguageAnchor(location.hash);
}

useLinkedPosition();
window.addEventListener("hashchange", useLinkedPosition);
window.addEventListener("pageshow", useLinkedPosition);
switcher.addEventListener("focusin", useReadingPosition);
switcher.addEventListener("pointerenter", useReadingPosition);
switcher.addEventListener("click", useReadingPosition);
