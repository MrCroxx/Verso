import { useId, useState } from "react";
import { Info } from "lucide-react";
import { translationCacheHitRate, translationTokensPerSecond, translationUsageCost, type TranslationUsage } from "../lib/translation-usage";
import type { UiMessages } from "../lib/ui-messages";
import { formatTranslationCost } from "../lib/translation-pricing";
import { useUiLocale } from "./ui-locale";
import { useAppSettings } from "./app-settings";

export function TranslationUsageSummary({ usage, cachedAt, messages }: { usage: TranslationUsage; cachedAt?: number; messages: UiMessages }) {
  const { locale } = useUiLocale();
  const { translationService } = useAppSettings();
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const rate = translationTokensPerSecond(usage);
  const cacheRate = translationCacheHitRate(usage);
  const cost = translationUsageCost(usage, translationService.pricing, cachedAt);
  const rows = [
    { label: "In", value: usage.inputTokens?.toLocaleString(locale) ?? "—", help: messages.translationInputHelp },
    { label: "Out", value: usage.outputTokens?.toLocaleString(locale) ?? "—", help: messages.translationOutputHelp },
    { label: messages.translationTotalLabel, value: usage.totalTokens.toLocaleString(locale) },
    { label: "TPS", value: rate?.toFixed(1) ?? "—", help: messages.translationTpsHelp },
    { label: messages.translationCacheLabel, value: cacheRate === undefined ? "—" : `${(cacheRate * 100).toFixed(1)}%`,
      help: messages.translationCacheHelp(usage.cachedInputTokens?.toLocaleString(locale) ?? "—") },
    ...(cost ? [{ label: messages.translationCostLabel, value: `${formatTranslationCost(cost, locale)}${cost.period ? ` · ${messages.pricingPeriods[cost.period]}` : ""}`, help: messages.translationCostHelp }] : []),
  ];
  return <div className="translation-usage" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
    onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
    onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); event.stopPropagation(); } }}>
    <button type="button" className="icon-button subtle" aria-label={messages.translationUsageLabel}
      aria-describedby={open ? tooltipId : undefined} onClick={() => setOpen(true)}>
      <Info size={15} aria-hidden="true" />
    </button>
    <div className="translation-usage-tooltip" id={tooltipId} role="tooltip" hidden={!open}>
      <strong>{messages.translationUsageLabel}</strong>
      <dl>{rows.map((row) => <div key={row.label} title={row.help}>
        <dt>{row.label}</dt><dd>{row.value}</dd>
      </div>)}</dl>
    </div>
  </div>;
}
