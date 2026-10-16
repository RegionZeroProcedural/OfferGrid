(() => {
  const BUILD = "3.7.61-js";

  function wireFallbackNav() {
    const header = document.querySelector("[data-site-header]");
    const toggle = header?.querySelector(".nav-toggle");
    const nav = header?.querySelector(".main-nav");
    if (!toggle || !nav || toggle.dataset.fallbackWired === "1") return;
    toggle.dataset.fallbackWired = "1";
    toggle.addEventListener("click", () => {
      const open = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    });
  }

  async function recoverBrokenBoot() {
    if (window.__OFFERGRID_CHROME_READY__ === BUILD) return;

    let serverBuild = BUILD;
    try {
      const response = await fetch("/api/config", {
        cache: "no-store",
        headers: {
          "Cache-Control": "no-cache",
          "X-OfferGrid-Client-Version": BUILD,
        },
      });
      if (response.ok) {
        const config = await response.json();
        serverBuild = String(config.version || BUILD);
      }
    } catch {}

    const key = `offergrid:boot-recovery:${serverBuild}`;
    try {
      if (sessionStorage.getItem(key) === "1") return;
      sessionStorage.setItem(key, "1");
    } catch {}

    const url = new URL(location.href);
    url.searchParams.set("og_recover", serverBuild);
    url.searchParams.set("og_t", String(Date.now()));
    location.replace(url.toString());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireFallbackNav, { once: true });
  } else {
    wireFallbackNav();
  }

  window.addEventListener("load", () => {
    setTimeout(recoverBrokenBoot, 6000);
  }, { once: true });
})();
