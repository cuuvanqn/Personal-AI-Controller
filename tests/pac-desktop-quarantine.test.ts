import { describe, expect, test } from "bun:test";
import {
  listWindows,
  takeScreenshot,
  mouseAction,
  keyboardAction,
  getCuaToolList,
  findCuaDriverExe,
  executeCuaTool,
} from "../src/daemon/desktop";

describe("PAC native desktop quarantine", () => {
  test("refuses window enumeration", async () => {
    await expect(listWindows()).rejects.toThrow("PAC_DESKTOP_DENIED");
  });

  test("refuses screenshots before touching any output file", async () => {
    await expect(takeScreenshot("should-never-be-created.png")).rejects.toThrow("PAC_DESKTOP_DENIED");
  });

  test("refuses pointer and keyboard injection", async () => {
    await expect(mouseAction("left_click", 0, 0)).rejects.toThrow("PAC_DESKTOP_DENIED");
    await expect(keyboardAction("^{ENTER}")).rejects.toThrow("PAC_DESKTOP_DENIED");
  });

  test("refuses native CUA tools, discovery and driver execution", async () => {
    await expect(getCuaToolList()).rejects.toThrow("PAC_DESKTOP_DENIED");
    await expect(findCuaDriverExe()).rejects.toThrow("PAC_DESKTOP_DENIED");
    await expect(executeCuaTool("click", { x: 0, y: 0 })).rejects.toThrow("PAC_DESKTOP_DENIED");
  });
});
