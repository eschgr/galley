import { describe, it, expect, vi } from 'vitest';
import { writeAndOpenPdf } from './exportPdf';

const DATA = Buffer.from('%PDF-1.7 fake');

describe('writeAndOpenPdf', () => {
  it('writes then opens the file it just wrote, with no error dialog', async () => {
    const writeFile = vi.fn(async () => undefined);
    const openPath = vi.fn(async () => '');
    const showError = vi.fn();

    await writeAndOpenPdf('/out/report.pdf', DATA, { writeFile, openPath, showError });

    expect(writeFile).toHaveBeenCalledWith('/out/report.pdf', DATA);
    expect(openPath).toHaveBeenCalledWith('/out/report.pdf');
    // Open happens strictly after a successful write.
    expect(writeFile.mock.invocationCallOrder[0]).toBeLessThan(
      openPath.mock.invocationCallOrder[0],
    );
    expect(showError).not.toHaveBeenCalled();
  });

  it('does not open the file when the write fails, and reports the write error', async () => {
    const writeFile = vi.fn(async () => {
      throw new Error('EACCES');
    });
    const openPath = vi.fn(async () => '');
    const showError = vi.fn();

    await writeAndOpenPdf('/out/report.pdf', DATA, { writeFile, openPath, showError });

    expect(openPath).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
    const [title, body] = showError.mock.calls[0];
    expect(title).toBe('Could not export PDF');
    expect(body).toContain('/out/report.pdf');
    expect(body).toContain('EACCES');
  });

  it('reports a non-fatal notice when the file was written but no viewer would open it', async () => {
    const writeFile = vi.fn(async () => undefined);
    const openPath = vi.fn(async () => 'No application is associated with .pdf');
    const showError = vi.fn();

    await writeAndOpenPdf('/out/report.pdf', DATA, { writeFile, openPath, showError });

    // The write still counts — the file is on disk.
    expect(writeFile).toHaveBeenCalledOnce();
    expect(showError).toHaveBeenCalledTimes(1);
    const [title, body] = showError.mock.calls[0];
    expect(title).toBe('Exported, but could not open the PDF');
    expect(body).toContain('No application is associated');
  });
});
