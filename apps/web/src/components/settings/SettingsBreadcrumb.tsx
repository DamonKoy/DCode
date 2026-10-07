import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { useI18n } from "../../hooks/useI18n";
import { SETTINGS_SECTION_LABEL_KEYS, type SettingsPath } from "./settingsSearch";

const EXTRA_BREADCRUMB_LABELS: Readonly<Record<string, string>> = {
  "/settings/diagnostics": "Diagnostics",
  "/settings/open-source-licenses": "Open source licenses",
};

/**
 * `Settings / Section`. The scope a change applies to lives at the top of the
 * page content, see `SettingsScopeSentence`.
 */
export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const { t } = useI18n();
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  const sectionKey =
    normalizedPathname in SETTINGS_SECTION_LABEL_KEYS
      ? SETTINGS_SECTION_LABEL_KEYS[normalizedPathname as SettingsPath]
      : null;
  const sectionLabel = sectionKey
    ? t(sectionKey)
    : (EXTRA_BREADCRUMB_LABELS[normalizedPathname] ?? null);
  const rootLabel = t("settings.breadcrumb.root");

  return (
    <WorkspaceBreadcrumb ariaLabel="Settings breadcrumb">
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>{rootLabel}</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate">
        {sectionLabel ?? rootLabel}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
