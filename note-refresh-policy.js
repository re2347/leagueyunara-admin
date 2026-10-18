export function shouldDeferLicenseRefresh({ activeNoteEditor = false, pendingNoteSaves = 0 } = {}) {
  return activeNoteEditor || Number(pendingNoteSaves) > 0;
}
