/** Hands a blob to the browser as a file download. */
export const downloadBlob = (blob: Blob, fileName: string): void => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    // The click has taken the URL; revoking it right away can cut the download short in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
};

/** A file name a file system accepts: unsafe characters become dashes, whitespace collapses. */
export const safeFileName = (name: string, fallback = 'untitled'): string => name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ') || fallback;
