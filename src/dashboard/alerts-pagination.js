export function renderAlertsPaginationControls({ container, page, totalRows, pageSize, onPageChange }) {
  if (!container) return;

  const pages = Math.ceil(totalRows / pageSize);
  container.innerHTML = "";
  if (pages <= 1) return;

  if (page > 0) {
    const prev = document.createElement("button");
    prev.className = "btn btn--ghost btn--sm";
    prev.textContent = "‹";
    prev.addEventListener("click", () => onPageChange(page - 1));
    container.appendChild(prev);
  }

  for (let i = 0; i < pages; i++) {
    const btn = document.createElement("button");
    btn.className = `btn btn--ghost btn--sm${i === page ? " active" : ""}`;
    btn.textContent = String(i + 1);
    btn.addEventListener("click", () => onPageChange(i));
    container.appendChild(btn);
  }

  if (page < pages - 1) {
    const next = document.createElement("button");
    next.className = "btn btn--ghost btn--sm";
    next.textContent = "›";
    next.addEventListener("click", () => onPageChange(page + 1));
    container.appendChild(next);
  }
}
