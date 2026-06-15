const FEEDBACK_EMAIL = "tuttistudios@gmail.com";

const CATEGORIES = [
  "Bug report",
  "Feature request",
  "Question",
  "General feedback",
];

export function showFeedbackDialog(): void {
  const backdrop = document.createElement("div");
  backdrop.className = "welcome-backdrop";
  backdrop.style.zIndex = "9999";

  const card = document.createElement("div");
  card.className = "feedback-dialog";

  const closeBtn = document.createElement("button");
  closeBtn.className = "about-close";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => backdrop.remove());

  const title = document.createElement("h2");
  title.className = "feedback-title";
  title.textContent = "Send Feedback";

  const catLabel = document.createElement("label");
  catLabel.className = "feedback-label";
  catLabel.textContent = "Category";

  const catSelect = document.createElement("select");
  catSelect.className = "feedback-select";
  for (const c of CATEGORIES) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    catSelect.appendChild(opt);
  }

  const descLabel = document.createElement("label");
  descLabel.className = "feedback-label";
  descLabel.textContent = "Description";

  const descArea = document.createElement("textarea");
  descArea.className = "feedback-textarea";
  descArea.placeholder = "Describe what happened, what you expected, or what you'd like to see…";
  descArea.rows = 6;

  const actions = document.createElement("div");
  actions.className = "feedback-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "feedback-btn-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => backdrop.remove());

  const sendBtn = document.createElement("button");
  sendBtn.className = "feedback-btn-send";
  sendBtn.textContent = "Send via Email";

  sendBtn.addEventListener("click", () => {
    const category = catSelect.value;
    const body = descArea.value.trim();
    if (!body) {
      descArea.focus();
      descArea.classList.add("feedback-textarea--error");
      return;
    }
    const subject = encodeURIComponent(`[RapidCAM] ${category}`);
    const encodedBody = encodeURIComponent(body);
    window.location.href = `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${encodedBody}`;
    backdrop.remove();
  });

  descArea.addEventListener("input", () => {
    descArea.classList.remove("feedback-textarea--error");
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(sendBtn);

  card.appendChild(closeBtn);
  card.appendChild(title);
  card.appendChild(catLabel);
  card.appendChild(catSelect);
  card.appendChild(descLabel);
  card.appendChild(descArea);
  card.appendChild(actions);
  backdrop.appendChild(card);

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });

  document.body.appendChild(backdrop);
  setTimeout(() => descArea.focus(), 50);
}
