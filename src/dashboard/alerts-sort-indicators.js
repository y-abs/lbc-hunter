export function updateAlertsSortIndicators({ selector, sortCol, sortDir }) {
  document.querySelectorAll(selector).forEach((th) => {
    const isActive = th.dataset.sortcol === sortCol;
    th.classList.toggle("sort-active", isActive);
    th.dataset.sortdir = isActive ? sortDir : "";
  });
}
