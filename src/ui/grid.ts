"use client";

import { AllEnterpriseModule, LicenseManager, ModuleRegistry } from "ag-grid-enterprise";
import { themeQuartz } from "ag-grid-community";

let registered = false;
export function setupGrid(licenseKey?: string) {
  if (registered) return;
  ModuleRegistry.registerModules([AllEnterpriseModule]);
  if (licenseKey) LicenseManager.setLicenseKey(licenseKey);
  registered = true;
}

export const gridTheme = themeQuartz.withParams({
  accentColor: "#0B6E55",
  fontFamily: "inherit",
  fontSize: 13,
  headerFontSize: 12,
  headerFontWeight: 600,
  headerBackgroundColor: "#F3F5F8",
  headerTextColor: "#3E4652",
  borderColor: "#E4E7EB",
  rowHoverColor: "#F5F8F6",
  selectedRowBackgroundColor: "#EAF5F0",
  wrapperBorderRadius: 10,
  rowHeight: 48,
  headerHeight: 40,
  cellHorizontalPadding: 14,
});

export const money = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US", { style: "currency", currency: "USD" }) : "");
