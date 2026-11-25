const button = document.querySelector(".copy-example");
const example = document.querySelector(".md-example code");
const message = document.querySelector(".copy-message");

if (navigator.clipboard?.writeText) {
  button.hidden = false;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(example.textContent);
      message.textContent = button.dataset.success;
    } catch {
      const range = document.createRange();
      range.selectNodeContents(example);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      message.textContent = button.dataset.failure;
    }
  });
}
