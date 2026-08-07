"use client";

import { useState } from "react";

type ProjectType = "typovy" | "individualni";
type Currency = "CZK" | "EUR";

type Fair = {
  id: string;
  name: string;
  priceList: string;
  defaultCurrency: Currency;
  logo: string;
};

type BoothVariant = {
  id: string;
  name: string;
};

type BoothType = {
  id: string;
  code: string;
  name: string;
  description: string;
  size: string;
  area: string;
  variants: BoothVariant[];
};

/* ------------------------------------------------ */
/* VELETRHY                                         */
/* ------------------------------------------------ */

const fairs: Fair[] = [
  {
    id: "for-beauty-autumn-2026",
    name: "FOR BEAUTY podzim 2026",
    priceList: "FOR BEAUTY podzim 2026",
    defaultCurrency: "CZK",
    logo: "/fairs/for-beauty.png",
  },
  {
    id: "for-decor-2026",
    name: "FOR DECOR 2026",
    priceList: "FOR DECOR 2026",
    defaultCurrency: "CZK",
    logo: "/fairs/for-decor.png",
  },
  {
    id: "international-2026",
    name: "Zahraniční veletrh 2026",
    priceList: "INTERNATIONAL 2026",
    defaultCurrency: "EUR",
    logo: "/fairs/international.png",
  },
];

/* ------------------------------------------------ */
/* TYPOVÉ STÁNKY                                    */
/* ------------------------------------------------ */

const boothTypes: BoothType[] = [
  {
    id: "koje-2x2",
    code: "K2",
    name: "Koje 2 × 2 m",
    description: "Základní otevřená veletržní koje.",
    size: "2 × 2 m",
    area: "4 m²",
    variants: [],
  },
  {
    id: "koje-3x2",
    code: "K3",
    name: "Koje 3 × 2 m",
    description: "Základní otevřená veletržní koje.",
    size: "3 × 2 m",
    area: "6 m²",
    variants: [],
  },
  {
    id: "t4",
    code: "T4",
    name: "Typový stánek T4",
    description: "Typová konstrukce T4 s několika variantami provedení.",
    size: "T4",
    area: "—",
    variants: [
      {
        id: "t4-v1",
        name: "Varianta 1",
      },
      {
        id: "t4-v2",
        name: "Varianta 2",
      },
      {
        id: "t4-v3",
        name: "Varianta 3",
      },
      {
        id: "t4-v4",
        name: "Varianta 4",
      },
    ],
  },
  {
    id: "t6",
    code: "T6",
    name: "Typový stánek T6",
    description: "Typová konstrukce T6 s několika variantami provedení.",
    size: "T6",
    area: "—",
    variants: [
      {
        id: "t6-v1",
        name: "Varianta 1",
      },
      {
        id: "t6-v2",
        name: "Varianta 2",
      },
      {
        id: "t6-v3",
        name: "Varianta 3",
      },
      {
        id: "t6-v4",
        name: "Varianta 4",
      },
    ],
  },
];

/* ------------------------------------------------ */
/* APP                                              */
/* ------------------------------------------------ */

export default function Home() {
  const [step, setStep] = useState(1);

  const [type, setType] = useState<ProjectType>("typovy");

  const [fairId, setFairId] = useState("");
  const [company, setCompany] = useState("");
  const [contact, setContact] = useState("");

  const [currency, setCurrency] = useState<Currency>("CZK");

  const [selectedBoothId, setSelectedBoothId] = useState("");
  const [selectedVariantId, setSelectedVariantId] = useState("");

  const selectedFair = fairs.find((fair) => fair.id === fairId);

  const selectedBooth = boothTypes.find(
    (booth) => booth.id === selectedBoothId
  );

  const selectedVariant = selectedBooth?.variants.find(
    (variant) => variant.id === selectedVariantId
  );

  function handleFairChange(id: string) {
    setFairId(id);

    const fair = fairs.find((item) => item.id === id);

    if (fair) {
      setCurrency(fair.defaultCurrency);
    } else {
      setCurrency("CZK");
    }
  }

  function handleBoothSelect(boothId: string) {
    setSelectedBoothId(boothId);
    setSelectedVariantId("");
  }

  /* ------------------------------------------------ */
  /* NOVÝ PROJEKT - KOMPLETNÍ RESET                  */
  /* ------------------------------------------------ */

  function startNewProject() {
    setStep(1);

    setType("typovy");

    setFairId("");
    setCompany("");
    setContact("");

    setCurrency("CZK");

    setSelectedBoothId("");
    setSelectedVariantId("");
  }

  const canOpenConfigurator =
    selectedBooth &&
    (selectedBooth.variants.length === 0 || selectedVariantId !== "");

  return (
    <main className="shell">
      {/* ------------------------------------------------ */}
      {/* SIDEBAR                                         */}
      {/* ------------------------------------------------ */}

      <aside className="sidebar">
        <a href="https://homeworkstudio.cz" className="logo">
          <span className="logoMain">HOMEWORK</span>
          <span className="logoSub">STUDIO</span>
        </a>

        <nav className="nav">
          <button
            type="button"
            className="navItem active"
            onClick={startNewProject}
          >
            <span className="navIcon">＋</span>
            Nový projekt
          </button>

          <button type="button" className="navItem">
            <span className="navIcon">□</span>
            Projekty
          </button>

          <button type="button" className="navItem">
            <span className="navIcon">◇</span>
            Knihovna stánků
          </button>

          <button type="button" className="navItem">
            <span className="navIcon">▦</span>
            Komponenty
          </button>
        </nav>

        <div className="sidebarBottom">
          <div className="appVersion">
            HOMEWORK BOOTH
            <span>Generator v0.1</span>
          </div>
        </div>
      </aside>

      {/* ------------------------------------------------ */}
      {/* MAIN                                            */}
      {/* ------------------------------------------------ */}

      <section className="main">
        {/* TOPBAR */}

        <header className="topbar">
          <div>
            <span className="sectionLabel">BOOTH GENERATOR</span>
          </div>

          <div className="steps">
            <div className={step >= 1 ? "step active" : "step"}>
              <span>1</span>
              Projekt
            </div>

            <div className="stepLine" />

            <div className={step >= 2 ? "step active" : "step"}>
              <span>2</span>
              Stánek
            </div>

            <div className="stepLine" />

            <div className={step >= 3 ? "step active" : "step"}>
              <span>3</span>
              Konfigurace
            </div>

            <div className="stepLine" />

            <div className="step">
              <span>4</span>
              Vizualizace
            </div>

            <div className="stepLine" />

            <div className="step">
              <span>5</span>
              Export
            </div>
          </div>
        </header>

        {/* ================================================= */}
        {/* STEP 1 - PROJEKT                                  */}
        {/* ================================================= */}

        {step === 1 && (
          <div className="page">
            <div className="pageIntro">
              <div>
                <span className="eyebrow">NOVÝ PROJEKT</span>

                <h1>Vytvořit nový stánek</h1>

                <p>
                  Zadej základní informace. Veletrh určuje ceník, výchozí měnu
                  a později také logo a další pravidla projektu.
                </p>
              </div>

              <div className="projectNumber">
                <span>PROJEKT</span>
                <strong>NEW</strong>
              </div>
            </div>

            <div className="contentGrid">
              <section className="card formCard">
                <div className="cardHeader">
                  <div>
                    <span className="cardNumber">01</span>
                    <h2>Informace o projektu</h2>
                  </div>

                  <span className="required">ZÁKLADNÍ ÚDAJE</span>
                </div>

                <div className="form">
                  <label>
                    <span>Veletrh</span>

                    <select
                      value={fairId}
                      onChange={(e) => handleFairChange(e.target.value)}
                    >
                      <option value="">Vyber veletrh</option>

                      {fairs.map((fair) => (
                        <option key={fair.id} value={fair.id}>
                          {fair.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  {selectedFair && (
                    <div className="fairInfo">
                      <div>
                        <span>CENÍK</span>
                        <strong>{selectedFair.priceList}</strong>
                      </div>

                      <div>
                        <span>VÝCHOZÍ MĚNA</span>
                        <strong>{selectedFair.defaultCurrency}</strong>
                      </div>

                      <div>
                        <span>LOGO</span>
                        <strong>Přiřazeno k veletrhu</strong>
                      </div>
                    </div>
                  )}

                  <div className="twoColumns">
                    <label>
                      <span>Firma / vystavovatel</span>

                      <input
                        value={company}
                        onChange={(e) => setCompany(e.target.value)}
                        placeholder="Název společnosti"
                      />
                    </label>

                    <label>
                      <span>Kontakt</span>

                      <input
                        value={contact}
                        onChange={(e) => setContact(e.target.value)}
                        placeholder="Jméno / e-mail"
                      />
                    </label>
                  </div>

                  <div className="currencySection">
                    <span className="fieldTitle">Měna projektu</span>

                    <div className="currencyButtons">
                      <button
                        type="button"
                        className={
                          currency === "CZK"
                            ? "currencyButton selected"
                            : "currencyButton"
                        }
                        onClick={() => setCurrency("CZK")}
                      >
                        <strong>CZK</strong>
                        <span>Kč</span>
                      </button>

                      <button
                        type="button"
                        className={
                          currency === "EUR"
                            ? "currencyButton selected"
                            : "currencyButton"
                        }
                        onClick={() => setCurrency("EUR")}
                      >
                        <strong>EUR</strong>
                        <span>€</span>
                      </button>
                    </div>

                    <p className="currencyHint">
                      Výchozí měna se nastaví podle veletrhu, ale můžeš ji pro
                      konkrétní projekt změnit.
                    </p>
                  </div>

                  <div className="projectType">
                    <span className="fieldTitle">Typ projektu</span>

                    <div className="typeCards">
                      <button
                        type="button"
                        className={
                          type === "typovy"
                            ? "projectTypeCard selected"
                            : "projectTypeCard"
                        }
                        onClick={() => setType("typovy")}
                      >
                        <div className="typeVisual">
                          <div className="typePlan">
                            <span className="wall wallTop" />
                            <span className="wall wallLeft" />
                          </div>
                        </div>

                        <div>
                          <strong>Typový stánek</strong>

                          <p>
                            Výběr z připravených rozměrů a variant konstrukce.
                          </p>
                        </div>

                        <span className="radio">
                          {type === "typovy" && <span />}
                        </span>
                      </button>

                      <button
                        type="button"
                        className={
                          type === "individualni"
                            ? "projectTypeCard selected"
                            : "projectTypeCard"
                        }
                        onClick={() => setType("individualni")}
                      >
                        <div className="typeVisual">
                          <div className="customShape" />
                        </div>

                        <div>
                          <strong>Individuální stánek</strong>

                          <p>
                            Vlastní rozměry, konstrukce a půdorys projektu.
                          </p>
                        </div>

                        <span className="radio">
                          {type === "individualni" && <span />}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <aside className="summaryCard">
                <div className="summaryHeader">
                  <span>NÁHLED PROJEKTU</span>
                  <span className="draft">DRAFT</span>
                </div>

                <div className="summaryBody">
                  <div className="emptyPreview">
                    <div className="previewCube">
                      <span className="cubeBack" />
                      <span className="cubeSide" />
                      <span className="cubeFloor" />
                    </div>

                    <strong>{company ? company : "Nový projekt"}</strong>

                    <p>Náhled stánku se zobrazí po výběru konstrukce.</p>
                  </div>
                </div>

                <div className="summaryInfo">
                  <div>
                    <span>VELETRH</span>
                    <strong>{selectedFair ? selectedFair.name : "—"}</strong>
                  </div>

                  <div>
                    <span>FIRMA</span>
                    <strong>{company || "—"}</strong>
                  </div>

                  <div>
                    <span>CENÍK</span>
                    <strong>
                      {selectedFair ? selectedFair.priceList : "—"}
                    </strong>
                  </div>

                  <div>
                    <span>MĚNA</span>
                    <strong>
                      {currency === "CZK" ? "CZK / Kč" : "EUR / €"}
                    </strong>
                  </div>

                  <div>
                    <span>TYP</span>
                    <strong>
                      {type === "typovy" ? "Typový" : "Individuální"}
                    </strong>
                  </div>
                </div>
              </aside>
            </div>

            <footer className="pageFooter">
              <span>Projekt zatím není uložen.</span>

              <button className="primaryButton" onClick={() => setStep(2)}>
                Pokračovat
                <span>→</span>
              </button>
            </footer>
          </div>
        )}

        {/* ================================================= */}
        {/* STEP 2 - VÝBĚR KONSTRUKCE                        */}
        {/* ================================================= */}

        {step === 2 && (
          <div className="page">
            <button className="back" onClick={() => setStep(1)}>
              ← Zpět na projekt
            </button>

            <div className="pageIntro">
              <div>
                <span className="eyebrow">KROK 02 / ZÁKLAD KONSTRUKCE</span>

                <h1>Vyber základ konstrukce</h1>

                <p>
                  Nejprve vyber typ stánku. Pokud konstrukce obsahuje více
                  variant, zobrazí se jejich výběr automaticky.
                </p>
              </div>
            </div>

            <div className="projectContext">
              <div>
                <span>VELETRH</span>
                <strong>{selectedFair?.name || "—"}</strong>
              </div>

              <div>
                <span>FIRMA</span>
                <strong>{company || "—"}</strong>
              </div>

              <div>
                <span>CENÍK</span>
                <strong>{selectedFair?.priceList || "—"}</strong>
              </div>

              <div>
                <span>MĚNA</span>
                <strong>{currency}</strong>
              </div>
            </div>

            {type === "typovy" ? (
              <>
                <section className="boothSelectionSection">
                  <div className="selectionTitle">
                    <div>
                      <span>01</span>

                      <div>
                        <small>ZÁKLAD</small>
                        <h2>Konstrukce stánku</h2>
                      </div>
                    </div>

                    <p>Vyber základní typ konstrukce.</p>
                  </div>

                  <div className="boothTypeGrid">
                    {boothTypes.map((booth) => {
                      const selected = selectedBoothId === booth.id;

                      return (
                        <button
                          key={booth.id}
                          type="button"
                          className={
                            selected
                              ? "boothTypeCard selected"
                              : "boothTypeCard"
                          }
                          onClick={() => handleBoothSelect(booth.id)}
                        >
                          <div className="boothCardCode">{booth.code}</div>

                          <div className="constructionPreview">
                            <div className="constructionShape">
                              <span className="constructionWallTop" />
                              <span className="constructionWallLeft" />
                            </div>
                          </div>

                          <div className="boothTypeContent">
                            <h3>{booth.name}</h3>

                            <p>{booth.description}</p>

                            <div className="boothMeta">
                              <span>{booth.size}</span>

                              {booth.variants.length > 0 ? (
                                <strong>
                                  {booth.variants.length} varianty
                                </strong>
                              ) : (
                                <strong>Bez variant</strong>
                              )}
                            </div>
                          </div>

                          {selected && (
                            <span className="boothCheck">✓</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </section>

                {selectedBooth && selectedBooth.variants.length > 0 && (
                  <section className="variantSection">
                    <div className="selectionTitle">
                      <div>
                        <span>02</span>

                        <div>
                          <small>VARIANTA</small>
                          <h2>{selectedBooth.name}</h2>
                        </div>
                      </div>

                      <p>Vyber konkrétní variantu konstrukce.</p>
                    </div>

                    <div className="variantGrid">
                      {selectedBooth.variants.map((variant, index) => {
                        const selected =
                          selectedVariantId === variant.id;

                        return (
                          <button
                            key={variant.id}
                            type="button"
                            className={
                              selected
                                ? "variantCard selected"
                                : "variantCard"
                            }
                            onClick={() =>
                              setSelectedVariantId(variant.id)
                            }
                          >
                            <div className="variantPreview">
                              <div
                                className={`variantShape variantShape${
                                  index + 1
                                }`}
                              >
                                <span className="variantWallA" />
                                <span className="variantWallB" />
                              </div>
                            </div>

                            <div className="variantContent">
                              <span>
                                {selectedBooth.code} / V{index + 1}
                              </span>

                              <strong>{variant.name}</strong>
                            </div>

                            {selected && (
                              <span className="variantCheck">✓</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                )}

                {selectedBooth &&
                  selectedBooth.variants.length === 0 && (
                    <div className="noVariantInfo">
                      <div className="noVariantIcon">✓</div>

                      <div>
                        <strong>{selectedBooth.name}</strong>

                        <p>
                          Tato konstrukce nemá další varianty. Můžeš
                          pokračovat přímo do konfigurátoru.
                        </p>
                      </div>
                    </div>
                  )}
              </>
            ) : (
              <div className="individualPlaceholder">
                <span>INDIVIDUÁLNÍ PROJEKT</span>

                <h2>Editor vlastního půdorysu</h2>

                <p>
                  Individuální konstrukce připravíme jako samostatnou část
                  generátoru.
                </p>
              </div>
            )}

            <footer className="pageFooter">
              <button
                className="secondaryButton"
                onClick={() => setStep(1)}
              >
                Zpět
              </button>

              {type === "typovy" ? (
                <button
                  className="primaryButton"
                  disabled={!canOpenConfigurator}
                  onClick={() => {
                    if (canOpenConfigurator) {
                      setStep(3);
                    }
                  }}
                >
                  Otevřít konfigurátor
                  <span>→</span>
                </button>
              ) : (
                <button className="primaryButton" disabled>
                  Otevřít konfigurátor
                  <span>→</span>
                </button>
              )}
            </footer>
          </div>
        )}

        {/* ================================================= */}
        {/* STEP 3                                           */}
        {/* ================================================= */}

        {step === 3 && (
          <div className="page configuratorPlaceholderPage">
            <button className="back" onClick={() => setStep(2)}>
              ← Zpět na výběr stánku
            </button>

            <div className="pageIntro">
              <div>
                <span className="eyebrow">KROK 03 / KONFIGURACE</span>

                <h1>Konfigurátor stánku</h1>

                <p>
                  Tady vytvoříme skutečnou pracovní plochu půdorysu a knihovnu
                  komponent.
                </p>
              </div>
            </div>

            <div className="configuratorPlaceholder">
              <div className="configuratorPlaceholderTop">
                <span>VYBRANÁ KONSTRUKCE</span>
                <strong>{selectedBooth?.name || "—"}</strong>
              </div>

              <div className="configuratorPlaceholderBody">
                <div className="placeholderPlan">
                  <span className="placeholderWallTop" />
                  <span className="placeholderWallLeft" />

                  <div className="placeholderCenter">
                    <span>PŮDORYS</span>
                    <strong>{selectedBooth?.size || "—"}</strong>
                  </div>
                </div>
              </div>

              <div className="configuratorPlaceholderInfo">
                <div>
                  <span>VELETRH</span>
                  <strong>{selectedFair?.name || "—"}</strong>
                </div>

                <div>
                  <span>KONSTRUKCE</span>
                  <strong>{selectedBooth?.code || "—"}</strong>
                </div>

                <div>
                  <span>VARIANTA</span>
                  <strong>{selectedVariant?.name || "Bez varianty"}</strong>
                </div>

                <div>
                  <span>MĚNA</span>
                  <strong>{currency}</strong>
                </div>
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}