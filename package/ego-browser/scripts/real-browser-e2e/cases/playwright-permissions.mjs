import { homeCase } from "./shared.mjs";

export const playwrightPermissionCases = [
  {
    name: "regression PWB-10 permission capability",
    body: homeCase(`
      let outcome = "unsupported";
      try {
        await cdp("Browser.grantPermissions", {
          origin: baseUrl,
          permissions: ["clipboardReadWrite", "geolocation"],
        });
        outcome = "supported";
      } catch (error) {
        const message = error?.message || String(error);
        throw new Error("permission CDP should be supported on Linux: " + message);
      }
      assertEqual(
        outcome,
        "supported",
        "PWB-10 Linux forwards the permission capability"
      );
      const granted = await page.evaluate(
        "navigator.permissions.query({name: 'geolocation'}).then(permission => permission.state)"
      );
      assertEqual(
        granted,
        "granted",
        "PWB-10 grantPermissions changes the active task space permission state"
      );
      await cdp("Browser.setPermission", {
        origin: baseUrl,
        permission: { name: "geolocation" },
        setting: "denied",
      });
      await page.reload();
      const denied = await page.evaluate(
        "navigator.permissions.query({name: 'geolocation'}).then(permission => permission.state)"
      );
      assertEqual(
        denied,
        "denied",
        "PWB-10 setPermission changes the active task space permission state"
      );
      await cdp("Browser.resetPermissions");
      await page.locator("#text-input").fill("clipboard-free input");
      assertEqual(
        await page.locator("#text-input").inputValue(),
        "clipboard-free input",
        "PWB-10 text entry does not require raw permission CDP"
      );
    `),
  },
];
