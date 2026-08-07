"use client";

import { useState } from "react";

type ProjectType = "typovy" | "individualni";

export default function Home() {
  const [step, setStep] = useState(1);
  const [type, setType] = useState<ProjectType>("typovy");

  const [fair, setFair] = useState("");
  const [company, setCompany] = useState("");
  const [contact, setContact] = useState("");

  if (step === 2) {
    return (
      <main className="app">
        <header className="header">
          <a href="https://homeworkstudio.cz" className="brand">
            <strong>HOMEWORK</strong>
            <span>STUDIO</span>
          </a>

          <div className="appName">BOOTH GENERATOR</div>
        </header>

        <section className="templatePage">
          <div className="templateHeader">
            <button className="backButton" onClick={() => setStep(1)}>
              ← Zpět
            </button>

            <div>
              <div className="eyebrow">KROK 02 / VÝBĚR STÁNKU</div>
              <h1>Vyber základ stánku.</h1>

              <p className="description">
                Začínáme nejmenší typovou variantou. Další rozměry a varianty
                budeme postupně přidávat.
              </p>
            </div>
          </div>

          <div className="projectSummary">
            <div>
              <small>VELETRH</small>
              <strong>{fair || "Neuvedeno"}</strong>
            </div>

            <div>
              <small>FIRMA</small>
              <strong>{company || "Neuvedeno"}</strong>
            </div>

            <div>
              <small>TYP</small>
              <strong>
                {type === "typovy" ? "Typový stánek" : "Individuální"}
              </strong>
            </div>
          </div>

          {type === "typovy" ? (
            <div className="templateGrid">
              <button className="boothCard selected">
                <div className="boothCardTop">
                  <span className="boothCode">K2</span>
                  <span className="selectedBadge">VYBRÁNO</span>
                </div>

                <div className="miniPlan">
                  <div className="miniWall" />
                  <span>2 × 2 m</span>
                </div>

                <div className="boothCardContent">
                  <h2>Koje 2 × 2 m</h2>
                  <p>Nejmenší základní typová expozice.</p>

                  <div className="specs">
                    <div>
                      <small>PLOCHA</small>
                      <strong>4 m²</strong>
                    </div>

                    <div>
                      <small>KOBEREC</small>
                      <strong>2 × 2 m</strong>
                    </div>

                    <div>
                      <small>STAVBA</small>
                      <strong>1 × 2 m</strong>
                    </div>
                  </div>
                </div>
              </button>

              <div className="futureCard">
                <span>DALŠÍ TYPY</span>
                <strong>3 × 2, 3 × 3, 3 × 4…</strong>
                <p>Budeme přidávat postupně.</p>
              </div>
            </div>
          ) : (
            <div className="individualBox">
              <span>INDIVIDUÁLNÍ STÁNEK</span>
              <h2>Vlastní rozměry a půdorys</h2>
              <p>
                Tohle bude další větev generátoru. Nejdřív dokončíme typové
                stánky.
              </p>
            </div>
          )}

          <div className="templateFooter">
            <button className="continue">
              Otevřít konfigurátor →
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="app">
      <header className="header">
        <a href="https://homeworkstudio.cz" className="brand">
          <strong>HOMEWORK</strong>
          <span>STUDIO</span>
        </a>

        <div className="appName">BOOTH GENERATOR</div>
      </header>

      <section className="workspace">
        <div className="formPanel">
          <div className="eyebrow">NOVÝ PROJEKT</div>

          <h1>Začněme nový stánek.</h1>

          <p className="description">
            Zadej základní údaje projektu. Rozložení stánku vytvoříme v dalším
            kroku.
          </p>

          <div className="form">
            <label>
              Veletrh
              <input
                value={fair}
                onChange={(e) => setFair(e.target.value)}
                placeholder="např. FOR BEAUTY podzim 2026"
              />
            </label>

            <label>
              Firma
              <input
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Název vystavovatele"
              />
            </label>

            <label>
              Kontakt
              <input
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder="Jméno / e-mail / telefon"
              />
            </label>

            <div className="field">
              <span className="label">Typ projektu</span>

              <div className="typeGrid">
                <button
                  className={type === "typovy" ? "type active" : "type"}
                  onClick={() => setType("typovy")}
                >
                  <strong>Typový stánek</strong>
                  <span>Předpřipravené rozměry a varianty</span>
                </button>

                <button
                  className={type === "individualni" ? "type active" : "type"}
                  onClick={() => setType("individualni")}
                >
                  <strong>Individuální</strong>
                  <span>Vlastní půdorys a rozměry</span>
                </button>
              </div>
            </div>

            <button className="continue" onClick={() => setStep(2)}>
              Pokračovat →
            </button>
          </div>
        </div>

        <div className="previewPanel">
          <div className="previewTop">
            <span>NÁHLED</span>
            <span className="status">PRVNÍ ŠABLONA</span>
          </div>

          <div className="boothArea">
            <div className="dimension topDimension">2000 mm</div>

            <div className="booth">
              <div className="backWall">
                <span>STAVBA 1 × 2 m</span>
              </div>

              <div className="carpet">
                <span>KOBEREC 2 × 2 m</span>
              </div>
            </div>

            <div className="dimension sideDimension">2000 mm</div>
          </div>

          <div className="previewInfo">
            <div>
              <small>PLOCHA</small>
              <strong>4 m²</strong>
            </div>

            <div>
              <small>ROZMĚR</small>
              <strong>2 × 2 m</strong>
            </div>

            <div>
              <small>STAVBA</small>
              <strong>1 × 2 m</strong>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}