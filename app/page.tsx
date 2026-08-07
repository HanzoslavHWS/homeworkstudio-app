"use client";

import { useState } from "react";

export default function Home() {
  const [type, setType] = useState<"typovy" | "individualni">("typovy");

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
              <input placeholder="např. FOR BEAUTY podzim 2026" />
            </label>

            <label>
              Firma
              <input placeholder="Název vystavovatele" />
            </label>

            <label>
              Kontakt
              <input placeholder="Jméno / e-mail / telefon" />
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

            <button className="continue">Pokračovat →</button>
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