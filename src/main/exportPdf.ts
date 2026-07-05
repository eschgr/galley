// The write-and-open step of File → Export to PDF, factored out of the Electron
// wiring so its decisions are testable without a live BrowserWindow or shell.
//
// The contract: write the rendered PDF, and only once it is safely on disk open
// it in the OS default viewer. A write failure is the important one — nothing
// lands, and the user sees why. A viewer that refuses to launch is secondary:
// the PDF already exists, so we report it without pretending the export failed.

export interface WriteAndOpenPdfDeps {
  /** Persist the rendered PDF bytes. Rejects on an IO failure. */
  writeFile: (filePath: string, data: Buffer) => Promise<void>;
  /**
   * Open the file in the OS default handler. Mirrors Electron's
   * `shell.openPath`: resolves to an empty string on success, or a non-empty
   * error message when no handler could be launched.
   */
  openPath: (filePath: string) => Promise<string>;
  /** Surface a message to the user (title, body). */
  showError: (title: string, message: string) => void;
}

// Write the PDF, then open it. Returns nothing — outcomes reach the user through
// `showError`. Order matters: we never attempt to open a file the write did not
// produce.
export async function writeAndOpenPdf(
  filePath: string,
  data: Buffer,
  deps: WriteAndOpenPdfDeps,
): Promise<void> {
  try {
    await deps.writeFile(filePath, data);
  } catch (err) {
    deps.showError('Could not export PDF', `${filePath}\n\n${String(err)}`);
    return;
  }
  const openError = await deps.openPath(filePath);
  if (openError) {
    deps.showError('Exported, but could not open the PDF', `${filePath}\n\n${openError}`);
  }
}
