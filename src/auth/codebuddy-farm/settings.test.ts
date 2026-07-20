import { describe, expect, test } from "bun:test";
import {
  codebuddyFarmSettingsToEnv,
  getCodeBuddyFarmUiDefaults,
  redactCodeBuddyFarmSettings,
} from "./settings";

describe("codebuddy farm settings map", () => {
  test("maps settings to env", () => {
    const env = codebuddyFarmSettingsToEnv({
      "codebuddy_farm.hme_url": "http://127.0.0.1:8081",
      "codebuddy_farm.di_login": "abc",
      "codebuddy_farm.di_password": "secret",
      "codebuddy_farm.captcha_solver_url": "http://127.0.0.1:8877",
    });
    expect(env.ICLOUD_HME_URL).toBe("http://127.0.0.1:8081");
    expect(env.DI_LOGIN).toBe("abc");
    expect(env.DI_PASSWORD).toBe("secret");
    expect(env.CAPTCHA_SOLVER_URL).toBe("http://127.0.0.1:8877");
    expect(env.MAIL_BACKEND).toBe("icloud_hme");
  });

  test("ui defaults clamp", () => {
    expect(getCodeBuddyFarmUiDefaults({ "codebuddy_farm.default_count": "3" }).count).toBe(3);
    expect(getCodeBuddyFarmUiDefaults({}).concurrent).toBe(1);
  });

  test("redacts di password", () => {
    const r = redactCodeBuddyFarmSettings({
      "codebuddy_farm.di_password": "supersecret",
      "codebuddy_farm.hme_url": "http://x",
    });
    expect(r["codebuddy_farm.di_password"]).toBe("***");
    expect(r["codebuddy_farm.di_password_set"]).toBe(true);
    expect(r["codebuddy_farm.hme_url"]).toBe("http://x");
  });
});
