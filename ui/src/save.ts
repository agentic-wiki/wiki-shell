/**
 * Hands the browser a file to save under `name`, as a download link would.
 *
 * For a file fetched with the token header (a link can't send it): the bytes
 * become an object URL that a hidden link downloads, and the URL is released
 * once the browser has had time to start the download.
 */
export function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
