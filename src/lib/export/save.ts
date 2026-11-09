// 書き出したファイルを端末に保存する。iPhone のホーム画面アプリでは通常のダウンロードがうまく動かないことがあるため、
// ファイルを共有できる端末では共有シート（navigator.share）を使い、できなければダウンロードにする。
export type SaveResult = "shared" | "downloaded" | "cancelled";

export async function saveFile(text: string, name: string, type: string): Promise<SaveResult> {
  const file = new File([text], name, { type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (typeof nav.share === "function" && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: name });
      return "shared";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
      // 共有に失敗したらダウンロードにする
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return "downloaded";
}
