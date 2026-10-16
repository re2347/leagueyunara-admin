/**
 * 敏感值遮罩：把卡密、设备标识、联系方式与金额在屏幕上遮住。
 *
 * 这是防旁人偷看的，不是安全边界 —— 数据仍在 DOM 里，复制按钮与 CSV 导出照常工作，
 * 所以按钮文案与提示都照实说「遮住」，不写成「加密」或「隐藏后无法读取」。
 */
const MASK_STORAGE = "yunara.admin.mask";

export function initMask() {
  const button = document.getElementById("mask-toggle");
  if (!button) return { isMasked: () => false };

  const readStored = () => {
    try {
      return localStorage.getItem(MASK_STORAGE) === "1";
    } catch {
      return false;
    }
  };

  const remember = (on) => {
    try {
      if (on) localStorage.setItem(MASK_STORAGE, "1");
      else localStorage.removeItem(MASK_STORAGE);
    } catch {
      /* 隐私模式下存不下，但这一屏该遮还是得遮 */
    }
  };

  function apply(on) {
    if (on) document.documentElement.dataset.mask = "sensitive";
    else delete document.documentElement.dataset.mask;
    button.setAttribute("aria-pressed", String(on));
    button.textContent = on ? "显示敏感值" : "遮住敏感值";
    button.title = on
      ? "当前已遮住卡密、设备标识与联系方式。点击恢复显示。"
      : "遮住卡密、设备标识与联系方式。只是遮住屏幕，不影响复制与导出。";
  }

  apply(readStored());
  button.addEventListener("click", () => {
    const next = button.getAttribute("aria-pressed") !== "true";
    apply(next);
    remember(next);
  });

  return { isMasked: () => document.documentElement.dataset.mask === "sensitive" };
}
