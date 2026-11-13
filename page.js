// A classic local script: Magpie inlines it with an allowed CSP hash.
async function connect() {
  const status = document.querySelector("#status"), retry = document.querySelector("#retry");
  retry.hidden = true;
  try {
    if (!window.magpie) throw new Error("请从 Magpie 的插件页面打开此页面。");
    await magpie.ready;
    let service = magpie.service;
    if (!service) {
      const options = await magpie.options.get();
      const port = Number.isInteger(options?.port) && options.port > 0 && options.port <= 65535 ? options.port : 3426;
      service = "http://127.0.0.1:" + port + "/";
    }
    const target = new URL(service);
    if (!["http:", "https:"].includes(target.protocol)) throw new Error("Magpie 未提供有效的控制页服务地址。");
    if (!target.pathname.endsWith("/")) target.pathname += "/";
    target.search = "?embedded=1";
    location.replace(target.href);
  } catch (error) {
    status.textContent = error.message || "连接失败，请确认插件已启用。";
    retry.hidden = false;
  }
}
document.querySelector("#retry").onclick = connect;
connect();
