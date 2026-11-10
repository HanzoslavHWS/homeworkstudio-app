"use client";

import { useState } from "react";
import { documentUsageAgreement, documentVariantOptions, type CatalogItemAdmin, type CatalogItemAdminEdit } from "../../domain/catalogItemsAdmin";
import {
  CARD_VARIANT_SCOPE_LABELS_CS,
  CARD_VARIANT_SCOPES,
  variantImageState,
  variantSeriesGroups,
  variantsForCard,
  type CardVariantScope,
  type CatalogVariant,
  type CatalogVariantSet,
} from "../../domain/catalogVariants";
import { useAssetUrl } from "../../hooks/useAssetUrl";
import { NativeSelect } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";

/**
 * Katalog → karta → "Barevné varianty" (V1-CARPET-02). Which colours of which swatch book the card
 * offers (document.variantOptions), grouped by product line, with code, swatch image and state. The
 * swatch book itself stays one separately managed object (Katalog komponent → Vzorníky); the rate
 * per colour is shown in the "Ceny" section below. Also holds the card's agreement-only flag
 * (document.usageAgreement — M04 Koberec PVA, hradí PVA).
 */
export function CatalogCardVariants({
  item,
  variantSets,
  allItems,
  onSave,
}: {
  item: CatalogItemAdmin;
  variantSets: readonly CatalogVariantSet[];
  allItems?: readonly CatalogItemAdmin[];
  onSave: (edit: CatalogItemAdminEdit) => Promise<void>;
}) {
  const stored = documentVariantOptions(item.document);
  const storedAgreement = documentUsageAgreement(item.document);
  const [setId, setSetId] = useState(stored?.variantSetId ?? "");
  const [scope, setScope] = useState<CardVariantScope>(stored?.scope ?? "billed_by_card");
  const [agreementOn, setAgreementOn] = useState(Boolean(storedAgreement));
  const [payer, setPayer] = useState(storedAgreement?.payerLabel ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const options = setId ? { variantSetId: setId, scope } : undefined;
  const variants = variantsForCard(variantSets, item.id, options, true);
  const groups = variantSeriesGroups(variants);
  const codeOf = (id: string | undefined) => (id ? allItems?.find((candidate) => candidate.id === id)?.abfCode ?? allItems?.find((candidate) => candidate.id === id)?.internalCode ?? "?" : "—");
  const images = { photo: 0, manual_review: 0, pending_permission: 0, rejected: 0, missing: 0 };
  for (const variant of variants) images[variantImageState(variant)] += 1;
  const dirty = (stored?.variantSetId ?? "") !== setId || (stored?.scope ?? "billed_by_card") !== scope || Boolean(storedAgreement) !== agreementOn || (storedAgreement?.payerLabel ?? "") !== payer.trim();

  async function save() {
    setBusy(true);
    setError("");
    try {
      await onSave({
        variantOptions: setId ? { variantSetId: setId, scope } : null,
        usageAgreement: agreementOn ? { payerLabel: payer.trim() } : null,
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Barevné varianty se nepodařilo uložit.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="catalogDetailSection catalogCardVariants">
      <h3>Barevné varianty</h3>
      <p className="fieldHint">Barvy, které lze u této karty vybrat. Všechny patří pod jeden ABF kód karty — nejsou to samostatné komponenty. Vzorník se spravuje v Katalog komponent → Vzorníky; sazbu za jednotku podle ceníku ukazuje sekce Ceny.</p>
      <div className="catalogCardVariantControls">
        <label>
          Vzorník
          <NativeSelect value={setId} onChange={(event) => setSetId(event.target.value)}>
            <option value="">— bez barevných variant —</option>
            {variantSets.map((set) => <option key={set.id} value={set.id}>{set.name} ({set.code}){set.isActive ? "" : " — neaktivní"}</option>)}
          </NativeSelect>
        </label>
        {setId && (
          <div className="catalogUsageChoice" role="radiogroup" aria-label="Rozsah barev">
            {CARD_VARIANT_SCOPES.map((option) => (
              <label key={option} className="checkboxRow">
                <input type="radio" name={`variant-scope-${item.id}`} checked={scope === option} onChange={() => setScope(option)} />
                <span><strong>{CARD_VARIANT_SCOPE_LABELS_CS[option]}</strong>{option === "billed_by_card" ? " — barvy, jejichž běžná účtovaná položka je tato karta (např. M01 = PLAT 020, M02 = ostatní)." : " — libovolná barva vzorníku bez ohledu na její běžné účtování (např. M04 Koberec PVA)."}</span>
              </label>
            ))}
          </div>
        )}
        <label className="checkboxRow">
          <input type="checkbox" checked={agreementOn} onChange={(event) => setAgreementOn(event.target.checked)} />
          <span>Použití jen na základě dohody — nenabízí se jako běžná náhrada; v kompletu vyžaduje důvod</span>
        </label>
        {agreementOn && (
          <label>
            Náklady nese
            <Input value={payer} onChange={(event) => setPayer(event.target.value)} placeholder="např. PVA" />
          </label>
        )}
        <div className="assetActions">
          <button type="button" className="smallUploadButton" disabled={!dirty || busy || (agreementOn && !payer.trim())} onClick={() => void save()}>{busy ? "Ukládám…" : "Uložit barevné varianty"}</button>
          {error && <small className="uploadError">{error}</small>}
        </div>
      </div>
      {storedAgreement && <p className="fieldWarning">Jen na základě dohody · náklady nese {storedAgreement.payerLabel}. Prodejní cena podle ceníku (0 Kč je platná cena).</p>}
      {setId && (
        <>
          <p className="fieldHint">
            {variants.length} barev ({variants.filter((variant) => variant.isActive).length} aktivních) · {groups.map((group) => `${group.series || "bez řady"} ${group.variants.length}`).join(" · ")} · obrázky: {images.photo} nahraných{images.manual_review ? `, ${images.manual_review} k ruční kontrole` : ""}{images.pending_permission ? `, ${images.pending_permission} čeká na oprávnění` : ""}{images.missing ? `, ${images.missing} chybí` : ""}{images.rejected ? `, ${images.rejected} zamítnuto` : ""}
          </p>
          {groups.map((group) => (
            <div key={group.series} className="catalogVariantSeries">
              <h4>{group.series ? `Řada ${group.series}` : "Bez řady"} <span className="fieldHint">· {group.variants.length} barev</span></h4>
              <ul className="catalogVariantGrid">
                {group.variants.map((variant) => <VariantTile key={variant.id} variant={variant} billedBy={scope === "all_variants" && variant.priceItemId !== item.id ? codeOf(variant.priceItemId) : undefined} />)}
              </ul>
            </div>
          ))}
          {variants.length === 0 && <p className="fieldHint">Ve vzorníku nejsou barvy pro tento rozsah.</p>}
        </>
      )}
    </section>
  );
}

function VariantTile({ variant, billedBy }: { variant: CatalogVariant; billedBy?: string }) {
  const photo = useAssetUrl(variant.photoAsset, undefined);
  const state = variantImageState(variant);
  return (
    <li className={`catalogVariantTile${variant.isActive ? "" : " isInactive"}`}>
      <span className="catalogVariantSwatch" style={variant.swatchColor ? { backgroundColor: variant.swatchColor } : undefined}>
        {photo.url ? <img src={photo.url} alt={variant.name} loading="lazy" /> : <small>{state === "manual_review" ? "Obrázek k ruční kontrole" : state === "pending_permission" ? "Obrázek čeká na oprávnění" : state === "rejected" ? "Obrázek nelze použít" : "Bez obrázku"}</small>}
      </span>
      <strong>{variant.code}</strong>
      <span>{variant.name}</span>
      <small className="fieldHint">
        {variant.isActive ? "aktivní" : "neaktivní"}
        {billedBy ? ` · běžně účtováno ${billedBy}` : ""}
        {!variant.textureAsset ? " · bez 3D textury" : " · 3D textura"}
        {(state === "pending_permission" || state === "manual_review") && variant.imageSource?.sourceImageUrl ? <> · <a href={variant.imageSource.sourceImageUrl} target="_blank" rel="noreferrer">zdroj</a></> : null}
      </small>
    </li>
  );
}
