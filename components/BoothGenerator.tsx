"use client";

import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { boothTypes } from "../data/booths";
import { componentCatalog, placeComponent } from "../data/components";
import { fairs } from "../data/fairs";
import type {
  Currency,
  PlacedComponent,
  ProjectType,
  RotationControlMode,
} from "../domain/models";
import { applySnap as snapPlacement, isPlacementValid } from "../geometry/placement";
import { quickRotation, rotationForMode } from "../geometry/rotation";
import { AppSidebar } from "./AppSidebar";
import { StepHeader } from "./StepHeader";
import { ComponentLibrary } from "./configurator/ComponentLibrary";
import { PricingBar } from "./configurator/PricingBar";
import { RotationNavigator } from "./configurator/RotationNavigator";
import { ScenePanel } from "./configurator/ScenePanel";

export default function BoothGenerator() {
  const canvasRef =
    useRef<HTMLDivElement | null>(null);

  const [step, setStep] =
    useState(1);

  const [type, setType] =
    useState<ProjectType>("typovy");

  const [fairId, setFairId] =
    useState("");

  const [company, setCompany] =
    useState("");

  const [contact, setContact] =
    useState("");

  const [currency, setCurrency] =
    useState<Currency>("CZK");

  const [
    selectedBoothId,
    setSelectedBoothId,
  ] = useState("");

  const [
    selectedVariantId,
    setSelectedVariantId,
  ] = useState("");

  const [
    placedComponents,
    setPlacedComponents,
  ] = useState<PlacedComponent[]>([]);

  const [
    selectedComponentId,
    setSelectedComponentId,
  ] = useState<string | null>(null);

  const [
    selectedConstructionPartId,
    setSelectedConstructionPartId,
  ] = useState<string | null>(null);

  const [
    draggingComponentId,
    setDraggingComponentId,
  ] = useState<string | null>(null);

  const [
    editorMessage,
    setEditorMessage,
  ] = useState("");

  /* ================================================= */
  /* DERIVED                                          */
  /* ================================================= */

  const selectedFair =
    fairs.find(
      (fair) =>
        fair.id === fairId
    );

  const selectedBooth =
    boothTypes.find(
      (booth) =>
        booth.id ===
        selectedBoothId
    );

  const selectedVariant =
    selectedBooth?.variants.find(
      (variant) =>
        variant.id ===
        selectedVariantId
    );

  const selectedPlacedComponent =
    placedComponents.find(
      (component) =>
        component.id ===
        selectedComponentId
    );

  const canOpenConfigurator =
    Boolean(
      selectedBooth &&
        selectedBooth.configReady &&
        (
          selectedBooth.variants.length ===
            0 ||
          selectedVariantId !== ""
        )
    );

  /* ================================================= */
  /* PROJECT                                          */
  /* ================================================= */

  function handleFairChange(
    id: string
  ) {
    setFairId(id);

    const fair =
      fairs.find(
        (item) =>
          item.id === id
      );

    if (fair) {
      setCurrency(
        fair.defaultCurrency
      );
    } else {
      setCurrency("CZK");
    }
  }

  function handleBoothSelect(
    boothId: string
  ) {
    setSelectedBoothId(
      boothId
    );

    setSelectedVariantId("");

    setPlacedComponents([]);
    setSelectedComponentId(null);
    setSelectedConstructionPartId(null);

    setEditorMessage("");
  }

  function startNewProject() {
    setStep(1);

    setType("typovy");

    setFairId("");
    setCompany("");
    setContact("");

    setCurrency("CZK");

    setSelectedBoothId("");
    setSelectedVariantId("");

    setPlacedComponents([]);
    setSelectedComponentId(null);
    setSelectedConstructionPartId(null);

    setDraggingComponentId(null);

    setEditorMessage("");
  }

  /* ================================================= */
  /* COLLISION                                        */
  /* ================================================= */



  function isPositionValid(
    component: PlacedComponent,
    centerX: number,
    centerY: number,
    rotationDeg: number
  ) {
    return selectedBooth
      ? isPlacementValid(selectedBooth, component, {
          x: centerX,
          y: centerY,
          rotationDeg,
        })
      : false;
  }

  /* ================================================= */
  /* SNAP                                             */
  /* ================================================= */

  function applySnap(
    component: PlacedComponent,
    centerX: number,
    centerY: number,
    rotationDeg: number
  ) {
    return selectedBooth
      ? snapPlacement(
          selectedBooth,
          component,
          centerX,
          centerY,
          rotationDeg
        )
      : { x: centerX, y: centerY };
  }

  /* ================================================= */
  /* ADD COMPONENTS                                   */
  /* ================================================= */

  function addCabinet() {
    const cabinet = placeComponent(
      componentCatalog.cabinet,
      "cabinet-" + Date.now(),
      1000,
      1350
    );

    setPlacedComponents((items) => [...items, cabinet]);
    setSelectedComponentId(cabinet.id);
    setSelectedConstructionPartId(null);
    setEditorMessage("");
  }

  function addChair() {
    const chair = placeComponent(
      componentCatalog.chair,
      "chair-" + Date.now(),
      1000,
      1500
    );

    setPlacedComponents((items) => [...items, chair]);
    setSelectedComponentId(chair.id);
    setSelectedConstructionPartId(null);
    setEditorMessage("");
  }

  /* ================================================= */
  /* MOVE                                             */
  /* ================================================= */

  function handleComponentPointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    componentId: string
  ) {
    event.stopPropagation();

    setSelectedComponentId(
      componentId
    );
    setSelectedConstructionPartId(null);

    setDraggingComponentId(
      componentId
    );

    setEditorMessage("");

    event.currentTarget.setPointerCapture(
      event.pointerId
    );
  }

  function handleComponentPointerMove(
    event: ReactPointerEvent<HTMLButtonElement>,
    componentId: string
  ) {
    if (
      draggingComponentId !==
        componentId ||
      !canvasRef.current ||
      !selectedBooth?.widthMm ||
      !selectedBooth.depthMm
    ) {
      return;
    }

    const component =
      placedComponents.find(
        (item) =>
          item.id ===
          componentId
      );

    if (!component) {
      return;
    }

    const rect =
      canvasRef.current.getBoundingClientRect();

    const pointerX =
      (
        (
          event.clientX -
          rect.left
        ) /
        rect.width
      ) *
      selectedBooth.widthMm;

    const pointerY =
      (
        (
          event.clientY -
          rect.top
        ) /
        rect.height
      ) *
      selectedBooth.depthMm;

    const snapped =
      applySnap(
        component,

        pointerX,
        pointerY,

        component.rotationDeg
      );

    /*
      1. Zkusíme normální pohyb.
    */

    if (
      isPositionValid(
        component,

        snapped.x,
        snapped.y,

        component.rotationDeg
      )
    ) {
      setPlacedComponents(
        (items) =>
          items.map(
            (item) =>
              item.id ===
              componentId
                ? {
                    ...item,

                    xMm:
                      Math.round(
                        snapped.x
                      ),

                    yMm:
                      Math.round(
                        snapped.y
                      ),
                  }
                : item
          )
      );

      setEditorMessage("");

      return;
    }

    /*
      2. Pokud je tam překážka,
      zkusíme sklouznout pouze po X.
    */

    if (
      isPositionValid(
        component,

        snapped.x,
        component.yMm,

        component.rotationDeg
      )
    ) {
      setPlacedComponents(
        (items) =>
          items.map(
            (item) =>
              item.id ===
              componentId
                ? {
                    ...item,

                    xMm:
                      Math.round(
                        snapped.x
                      ),
                  }
                : item
          )
      );

      setEditorMessage(
        "Konstrukce blokuje pohyb v ose Y."
      );

      return;
    }

    /*
      3. Potom pouze Y.
    */

    if (
      isPositionValid(
        component,

        component.xMm,
        snapped.y,

        component.rotationDeg
      )
    ) {
      setPlacedComponents(
        (items) =>
          items.map(
            (item) =>
              item.id ===
              componentId
                ? {
                    ...item,

                    yMm:
                      Math.round(
                        snapped.y
                      ),
                  }
                : item
          )
      );

      setEditorMessage(
        "Konstrukce blokuje pohyb v ose X."
      );

      return;
    }

    /*
      4. Jinak objekt zůstane stát.
    */

    setEditorMessage(
      "Kolize s konstrukcí – objekt tudy neprojde."
    );
  }

  function handleComponentPointerUp(
    event: ReactPointerEvent<HTMLButtonElement>
  ) {
    setDraggingComponentId(
      null
    );

    if (
      event.currentTarget.hasPointerCapture(
        event.pointerId
      )
    ) {
      event.currentTarget.releasePointerCapture(
        event.pointerId
      );
    }
  }

  /* ================================================= */
  /* ROTATION                                         */
  /* ================================================= */

  function setSelectedRotation(
    requestedAngle: number
  ) {
    if (!selectedPlacedComponent) {
      return;
    }

    const newAngle = rotationForMode(
      selectedPlacedComponent.rotation,
      selectedPlacedComponent.rotationMode,
      requestedAngle,
      selectedPlacedComponent.rotationDeg
    );

    if (
      selectedPlacedComponent.rotation.locked ||
      newAngle === selectedPlacedComponent.rotationDeg
    ) {
      return;
    }

    const valid = isPositionValid(
      selectedPlacedComponent,
      selectedPlacedComponent.xMm,
      selectedPlacedComponent.yMm,
      newAngle
    );

    if (!valid) {
      setEditorMessage(
        "Rotaci blokuje konstrukce nebo hranice stánku."
      );
      return;
    }

    setPlacedComponents((items) =>
      items.map((item) =>
        item.id === selectedPlacedComponent.id
          ? { ...item, rotationDeg: newAngle }
          : item
      )
    );
    setEditorMessage("");
  }

  function setSelectedQuickRotation(
    requestedAngle: number
  ) {
    if (!selectedPlacedComponent) {
      return;
    }

    const newAngle = quickRotation(
      selectedPlacedComponent.rotation,
      requestedAngle,
      selectedPlacedComponent.rotationDeg
    );

    if (
      selectedPlacedComponent.rotation.locked ||
      newAngle === selectedPlacedComponent.rotationDeg
    ) {
      return;
    }

    if (
      !isPositionValid(
        selectedPlacedComponent,
        selectedPlacedComponent.xMm,
        selectedPlacedComponent.yMm,
        newAngle
      )
    ) {
      setEditorMessage(
        "Rotaci blokuje konstrukce nebo hranice stánku."
      );
      return;
    }

    setPlacedComponents((items) =>
      items.map((item) =>
        item.id === selectedPlacedComponent.id
          ? { ...item, rotationDeg: newAngle }
          : item
      )
    );
    setEditorMessage("");
  }

  function setSelectedRotationMode(
    mode: RotationControlMode
  ) {
    if (
      !selectedPlacedComponent ||
      selectedPlacedComponent.rotation.locked ||
      (mode === "free" &&
        !selectedPlacedComponent.rotation.allowFreeRotation)
    ) {
      return;
    }

    setPlacedComponents((items) =>
      items.map((item) =>
        item.id === selectedPlacedComponent.id
          ? { ...item, rotationMode: mode }
          : item
      )
    );
  }



  /* ================================================= */
  /* DUPLICATE / DELETE                               */
  /* ================================================= */

  function duplicateSelectedComponent() {
    if (
      !selectedPlacedComponent
    ) {
      return;
    }

    const clone: PlacedComponent = {
      ...selectedPlacedComponent,

      id:
        selectedPlacedComponent.type +
        "-" +
        Date.now(),

      name:
        selectedPlacedComponent.name,

      xMm:
        selectedPlacedComponent.xMm +
        120,

      yMm:
        selectedPlacedComponent.yMm +
        120,
    };

    const snapped =
      applySnap(
        clone,

        clone.xMm,
        clone.yMm,

        clone.rotationDeg
      );

    const valid =
      isPositionValid(
        clone,

        snapped.x,
        snapped.y,

        clone.rotationDeg
      );

    if (valid) {
      clone.xMm =
        Math.round(
          snapped.x
        );

      clone.yMm =
        Math.round(
          snapped.y
        );
    } else {
      clone.xMm =
        selectedPlacedComponent.xMm;

      clone.yMm =
        selectedPlacedComponent.yMm;
    }

    setPlacedComponents(
      (items) => [
        ...items,
        clone,
      ]
    );

    setSelectedComponentId(
      clone.id
    );
    setSelectedConstructionPartId(null);

    setEditorMessage("");
  }

  function deleteSelectedComponent() {
    if (
      !selectedComponentId
    ) {
      return;
    }

    setPlacedComponents(
      (items) =>
        items.filter(
          (item) =>
            item.id !==
            selectedComponentId
        )
    );

    setSelectedComponentId(
      null
    );

    setEditorMessage("");
  }

  function selectSceneComponent(componentId: string) {
    setSelectedComponentId(componentId);
    setSelectedConstructionPartId(null);
    setEditorMessage("");
  }

  function selectConstructionPart(partId: string) {
    setSelectedComponentId(null);
    setSelectedConstructionPartId(partId);
    setEditorMessage("");
  }

  function resetConfigurator() {
    setPlacedComponents([]);
    setSelectedComponentId(null);
    setSelectedConstructionPartId(null);

    setEditorMessage("");
  }

  /* ================================================= */
  /* RENDER                                           */
  /* ================================================= */

  return (
    <main className="shell">
      {/* ================================================= */}
      {/* SIDEBAR                                         */}
      {/* ================================================= */}

      <AppSidebar onStartNewProject={startNewProject} />

      {/* ================================================= */}
      {/* MAIN                                            */}
      {/* ================================================= */}

      <section className="main">
        {/* ================================================= */}
        {/* TOPBAR                                         */}
        {/* ================================================= */}

        <StepHeader currentStep={step} />

        {/* ================================================= */}
        {/* STEP 1                                          */}
        {/* ================================================= */}

        {step === 1 && (
          <div className="page">
            <div className="pageIntro">
              <div>
                <span className="eyebrow">
                  NOVÝ PROJEKT
                </span>

                <h1>
                  Vytvořit nový stánek
                </h1>

                <p>
                  Zadej základní informace.
                  Veletrh určuje ceník,
                  výchozí měnu a později také
                  logo a další pravidla projektu.
                </p>
              </div>

              <div className="projectNumber">
                <span>
                  PROJEKT
                </span>

                <strong>
                  NEW
                </strong>
              </div>
            </div>

            <div className="contentGrid">
              <section className="card formCard">
                <div className="cardHeader">
                  <div>
                    <span className="cardNumber">
                      01
                    </span>

                    <h2>
                      Informace o projektu
                    </h2>
                  </div>

                  <span className="required">
                    ZÁKLADNÍ ÚDAJE
                  </span>
                </div>

                <div className="form">
                  <label>
                    <span>
                      Veletrh
                    </span>

                    <select
                      value={fairId}
                      onChange={(event) =>
                        handleFairChange(
                          event.target.value
                        )
                      }
                    >
                      <option value="">
                        Vyber veletrh
                      </option>

                      {fairs.map(
                        (fair) => (
                          <option
                            key={
                              fair.id
                            }
                            value={
                              fair.id
                            }
                          >
                            {
                              fair.name
                            }
                          </option>
                        )
                      )}
                    </select>
                  </label>

                  {selectedFair && (
                    <div className="fairInfo">
                      <div>
                        <span>
                          CENÍK
                        </span>

                        <strong>
                          {
                            selectedFair.priceList
                          }
                        </strong>
                      </div>

                      <div>
                        <span>
                          VÝCHOZÍ MĚNA
                        </span>

                        <strong>
                          {
                            selectedFair.defaultCurrency
                          }
                        </strong>
                      </div>

                      <div>
                        <span>
                          LOGO
                        </span>

                        <strong>
                          Přiřazeno k veletrhu
                        </strong>
                      </div>
                    </div>
                  )}

                  <div className="twoColumns">
                    <label>
                      <span>
                        Firma / vystavovatel
                      </span>

                      <input
                        value={company}
                        onChange={(event) =>
                          setCompany(
                            event.target.value
                          )
                        }
                        placeholder="Název společnosti"
                      />
                    </label>

                    <label>
                      <span>
                        Kontakt
                      </span>

                      <input
                        value={contact}
                        onChange={(event) =>
                          setContact(
                            event.target.value
                          )
                        }
                        placeholder="Jméno / e-mail"
                      />
                    </label>
                  </div>

                  <div className="currencySection">
                    <span className="fieldTitle">
                      Měna projektu
                    </span>

                    <div className="currencyButtons">
                      <button
                        type="button"
                        className={
                          currency ===
                          "CZK"
                            ? "currencyButton selected"
                            : "currencyButton"
                        }
                        onClick={() =>
                          setCurrency(
                            "CZK"
                          )
                        }
                      >
                        <strong>
                          CZK
                        </strong>

                        <span>
                          Kč
                        </span>
                      </button>

                      <button
                        type="button"
                        className={
                          currency ===
                          "EUR"
                            ? "currencyButton selected"
                            : "currencyButton"
                        }
                        onClick={() =>
                          setCurrency(
                            "EUR"
                          )
                        }
                      >
                        <strong>
                          EUR
                        </strong>

                        <span>
                          €
                        </span>
                      </button>
                    </div>

                    <p className="currencyHint">
                      Výchozí měna se nastaví podle veletrhu,
                      ale můžeš ji pro konkrétní projekt změnit.
                    </p>
                  </div>

                  <div className="projectType">
                    <span className="fieldTitle">
                      Typ projektu
                    </span>

                    <div className="typeCards">
                      <button
                        type="button"
                        className={
                          type ===
                          "typovy"
                            ? "projectTypeCard selected"
                            : "projectTypeCard"
                        }
                        onClick={() =>
                          setType(
                            "typovy"
                          )
                        }
                      >
                        <div className="typeVisual">
                          <div className="typePlan">
                            <span className="wall wallTop" />
                            <span className="wall wallLeft" />
                          </div>
                        </div>

                        <div>
                          <strong>
                            Typový stánek
                          </strong>

                          <p>
                            Výběr z připravených
                            rozměrů a variant
                            konstrukce.
                          </p>
                        </div>

                        <span className="radio">
                          {type ===
                            "typovy" && (
                            <span />
                          )}
                        </span>
                      </button>

                      <button
                        type="button"
                        className={
                          type ===
                          "individualni"
                            ? "projectTypeCard selected"
                            : "projectTypeCard"
                        }
                        onClick={() =>
                          setType(
                            "individualni"
                          )
                        }
                      >
                        <div className="typeVisual">
                          <div className="customShape" />
                        </div>

                        <div>
                          <strong>
                            Individuální stánek
                          </strong>

                          <p>
                            Vlastní rozměry,
                            konstrukce a půdorys
                            projektu.
                          </p>
                        </div>

                        <span className="radio">
                          {type ===
                            "individualni" && (
                            <span />
                          )}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <aside className="summaryCard">
                <div className="summaryHeader">
                  <span>
                    NÁHLED PROJEKTU
                  </span>

                  <span className="draft">
                    DRAFT
                  </span>
                </div>

                <div className="summaryBody">
                  <div className="emptyPreview">
                    <div className="previewCube">
                      <span className="cubeBack" />
                      <span className="cubeSide" />
                      <span className="cubeFloor" />
                    </div>

                    <strong>
                      {company
                        ? company
                        : "Nový projekt"}
                    </strong>

                    <p>
                      Náhled stánku se zobrazí po
                      výběru konstrukce.
                    </p>
                  </div>
                </div>

                <div className="summaryInfo">
                  <div>
                    <span>
                      VELETRH
                    </span>

                    <strong>
                      {selectedFair
                        ? selectedFair.name
                        : "—"}
                    </strong>
                  </div>

                  <div>
                    <span>
                      FIRMA
                    </span>

                    <strong>
                      {company || "—"}
                    </strong>
                  </div>

                  <div>
                    <span>
                      CENÍK
                    </span>

                    <strong>
                      {selectedFair
                        ? selectedFair.priceList
                        : "—"}
                    </strong>
                  </div>

                  <div>
                    <span>
                      MĚNA
                    </span>

                    <strong>
                      {currency ===
                      "CZK"
                        ? "CZK / Kč"
                        : "EUR / €"}
                    </strong>
                  </div>

                  <div>
                    <span>
                      TYP
                    </span>

                    <strong>
                      {type ===
                      "typovy"
                        ? "Typový"
                        : "Individuální"}
                    </strong>
                  </div>
                </div>
              </aside>
            </div>

            <footer className="pageFooter">
              <span>
                Projekt zatím není uložen.
              </span>

              <button
                className="primaryButton"
                onClick={() =>
                  setStep(2)
                }
              >
                Pokračovat

                <span>
                  →
                </span>
              </button>
            </footer>
          </div>
        )}

        {/* ================================================= */}
        {/* STEP 2                                          */}
        {/* ================================================= */}

        {step === 2 && (
          <div className="page">
            <button
              className="back"
              onClick={() =>
                setStep(1)
              }
            >
              ← Zpět na projekt
            </button>

            <div className="pageIntro">
              <div>
                <span className="eyebrow">
                  KROK 02 / ZÁKLAD KONSTRUKCE
                </span>

                <h1>
                  Vyber základ konstrukce
                </h1>

                <p>
                  Nejprve vyber typ stánku.
                  Pokud konstrukce obsahuje více
                  variant, zobrazí se jejich
                  výběr automaticky.
                </p>
              </div>
            </div>

            <div className="projectContext">
              <div>
                <span>
                  VELETRH
                </span>

                <strong>
                  {selectedFair?.name ||
                    "—"}
                </strong>
              </div>

              <div>
                <span>
                  FIRMA
                </span>

                <strong>
                  {company || "—"}
                </strong>
              </div>

              <div>
                <span>
                  CENÍK
                </span>

                <strong>
                  {selectedFair?.priceList ||
                    "—"}
                </strong>
              </div>

              <div>
                <span>
                  MĚNA
                </span>

                <strong>
                  {currency}
                </strong>
              </div>
            </div>

            {type ===
            "typovy" ? (
              <>
                <section className="boothSelectionSection">
                  <div className="selectionTitle">
                    <div>
                      <span>
                        01
                      </span>

                      <div>
                        <small>
                          ZÁKLAD
                        </small>

                        <h2>
                          Konstrukce stánku
                        </h2>
                      </div>
                    </div>

                    <p>
                      Vyber základní typ konstrukce.
                    </p>
                  </div>

                  <div className="boothTypeGrid">
                    {boothTypes.map(
                      (booth) => {
                        const selected =
                          selectedBoothId ===
                          booth.id;

                        return (
                          <button
                            key={
                              booth.id
                            }
                            type="button"
                            className={
                              selected
                                ? "boothTypeCard selected"
                                : "boothTypeCard"
                            }
                            onClick={() =>
                              handleBoothSelect(
                                booth.id
                              )
                            }
                          >
                            <div className="boothCardCode">
                              {
                                booth.code
                              }
                            </div>

                            {!booth.configReady && (
                              <span className="cadPending">
                                CAD ČEKÁ
                              </span>
                            )}

                            <div className="constructionPreview">
                              <div className="constructionShape">
                                <span className="constructionWallTop" />
                                <span className="constructionWallLeft" />
                              </div>
                            </div>

                            <div className="boothTypeContent">
                              <h3>
                                {
                                  booth.name
                                }
                              </h3>

                              <p>
                                {
                                  booth.description
                                }
                              </p>

                              <div className="boothMeta">
                                <span>
                                  {
                                    booth.size
                                  }
                                </span>

                                {booth
                                  .variants
                                  .length >
                                0 ? (
                                  <strong>
                                    {
                                      booth
                                        .variants
                                        .length
                                    }{" "}
                                    varianty
                                  </strong>
                                ) : (
                                  <strong>
                                    Bez variant
                                  </strong>
                                )}
                              </div>
                            </div>

                            {selected && (
                              <span className="boothCheck">
                                ✓
                              </span>
                            )}
                          </button>
                        );
                      }
                    )}
                  </div>
                </section>

                {selectedBooth &&
                  selectedBooth
                    .variants
                    .length >
                    0 && (
                    <section className="variantSection">
                      <div className="selectionTitle">
                        <div>
                          <span>
                            02
                          </span>

                          <div>
                            <small>
                              VARIANTA
                            </small>

                            <h2>
                              {
                                selectedBooth.name
                              }
                            </h2>
                          </div>
                        </div>

                        <p>
                          Vyber konkrétní variantu konstrukce.
                        </p>
                      </div>

                      <div className="variantGrid">
                        {selectedBooth.variants.map(
                          (
                            variant,
                            index
                          ) => {
                            const selected =
                              selectedVariantId ===
                              variant.id;

                            return (
                              <button
                                key={
                                  variant.id
                                }
                                type="button"
                                className={
                                  selected
                                    ? "variantCard selected"
                                    : "variantCard"
                                }
                                onClick={() =>
                                  setSelectedVariantId(
                                    variant.id
                                  )
                                }
                              >
                                <div className="variantPreview">
                                  <div
                                    className={`variantShape variantShape${
                                      index +
                                      1
                                    }`}
                                  >
                                    <span className="variantWallA" />
                                    <span className="variantWallB" />
                                  </div>
                                </div>

                                <div className="variantContent">
                                  <span>
                                    {
                                      selectedBooth.code
                                    }{" "}
                                    / V
                                    {index +
                                      1}
                                  </span>

                                  <strong>
                                    {
                                      variant.name
                                    }
                                  </strong>
                                </div>

                                {selected && (
                                  <span className="variantCheck">
                                    ✓
                                  </span>
                                )}
                              </button>
                            );
                          }
                        )}
                      </div>
                    </section>
                  )}

                {selectedBooth &&
                  selectedBooth
                    .variants
                    .length ===
                    0 && (
                    <div className="noVariantInfo">
                      <div className="noVariantIcon">
                        ✓
                      </div>

                      <div>
                        <strong>
                          {
                            selectedBooth.name
                          }
                        </strong>

                        {selectedBooth.configReady ? (
                          <p>
                            Tato konstrukce nemá
                            další varianty. Můžeš
                            pokračovat přímo do
                            konfigurátoru.
                          </p>
                        ) : (
                          <p>
                            Výběr je připravený,
                            ale konfigurátor čeká
                            na přesnou CAD
                            geometrii této
                            konstrukce.
                          </p>
                        )}
                      </div>
                    </div>
                  )}
              </>
            ) : (
              <div className="individualPlaceholder">
                <span>
                  INDIVIDUÁLNÍ PROJEKT
                </span>

                <h2>
                  Editor vlastního půdorysu
                </h2>

                <p>
                  Individuální konstrukce
                  připravíme jako samostatnou
                  část generátoru.
                </p>
              </div>
            )}

            <footer className="pageFooter">
              <button
                className="secondaryButton"
                onClick={() =>
                  setStep(1)
                }
              >
                Zpět
              </button>

              <button
                className="primaryButton"
                disabled={
                  !canOpenConfigurator
                }
                onClick={() => {
                  if (
                    canOpenConfigurator
                  ) {
                    setStep(
                      3
                    );
                  }
                }}
              >
                Otevřít konfigurátor

                <span>
                  →
                </span>
              </button>
            </footer>
          </div>
        )}

        {/* ================================================= */}
        {/* STEP 3                                          */}
        {/* ================================================= */}

        {step === 3 &&
          selectedBooth &&
          selectedBooth.widthMm &&
          selectedBooth.depthMm && (
            <div className="configuratorPage">
              {/* HEADER */}

              <div className="configuratorHeader">
                <div>
                  <button
                    className="back"
                    onClick={() =>
                      setStep(2)
                    }
                  >
                    ← Zpět na výběr stánku
                  </button>

                  <span className="eyebrow">
                    KROK 03 / KONFIGURACE
                  </span>

                  <h1>
                    {
                      selectedBooth.name
                    }
                  </h1>
                </div>

                <div className="configuratorHeaderActions">
                  <div className="viewSwitch">
                    <button className="viewButton active">
                      2D
                    </button>

                    <button
                      className="viewButton"
                      disabled
                    >
                      3D
                    </button>
                  </div>

                  <button
                    className="lightButton"
                    onClick={
                      resetConfigurator
                    }
                  >
                    Reset rozmístění
                  </button>
                </div>
              </div>

              {/* WORKSPACE */}

              <div className="configuratorWorkspace">
                {/* COMPONENT LIBRARY */}

                <ComponentLibrary
                  onAddCabinet={addCabinet}
                  onAddChair={addChair}
                />

                {/* PLAN */}

                <section className="planWorkspace">
                  <div className="planToolbar">
                    <div>
                      <span>
                        PŮDORYS
                      </span>

                      <strong>
                        {
                          selectedBooth.widthMm
                        }{" "}
                        ×{" "}
                        {
                          selectedBooth.depthMm
                        }{" "}
                        mm
                      </strong>
                    </div>

                    <div className="planToolbarInfo">
                      <span>
                        GRID 250 mm
                      </span>

                      <span>
                        SNAP 40 mm
                      </span>

                      <span className="collisionOn">
                        KOLIZE ON
                      </span>
                    </div>
                  </div>

                  {/* OBJECT NAVIGATOR */}

                  <div
                    className={
                      selectedPlacedComponent
                        ? "objectNavigator active"
                        : "objectNavigator"
                    }
                  >
                    {selectedPlacedComponent ? (
                      <>
                        <div className="navigatorObject">
                          <span>
                            VYBRANÝ OBJEKT
                          </span>

                          <strong>
                            {
                              selectedPlacedComponent.name
                            }
                          </strong>
                        </div>

                        <div className="navigatorCoords">
                          <div>
                            <span>
                              X
                            </span>

                            <strong>
                              {Math.round(
                                selectedPlacedComponent.xMm
                              )}{" "}
                              mm
                            </strong>
                          </div>

                          <div>
                            <span>
                              Y
                            </span>

                            <strong>
                              {Math.round(
                                selectedPlacedComponent.yMm
                              )}{" "}
                              mm
                            </strong>
                          </div>
                        </div>

                        <div className="navigatorDivider" />

                        <RotationNavigator
                          component={selectedPlacedComponent}
                          onQuickAngle={setSelectedQuickRotation}
                          onRotationChange={setSelectedRotation}
                          onModeChange={setSelectedRotationMode}
                        />

                        <div className="navigatorDivider" />

                        <div className="navigatorActions">
                          <button
                            onClick={
                              duplicateSelectedComponent
                            }
                          >
                            Duplikovat
                          </button>

                          <button
                            className="deleteNavigatorButton"
                            onClick={
                              deleteSelectedComponent
                            }
                          >
                            Smazat
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="navigatorEmpty">
                        Vyber objekt v půdorysu – zde se zobrazí jeho
                        pozice a ovládání rotace.
                      </div>
                    )}
                  </div>

                  {editorMessage && (
                    <div className="editorMessage">
                      <span>
                        !
                      </span>

                      {
                        editorMessage
                      }
                    </div>
                  )}

                  <div className="canvasArea">
                    <div className="dimensionTop">
                      <span>
                        {
                          selectedBooth.widthMm
                        }{" "}
                        mm
                      </span>
                    </div>

                    <div className="dimensionLeft">
                      <span>
                        {
                          selectedBooth.depthMm
                        }{" "}
                        mm
                      </span>
                    </div>

                    <div
                      ref={canvasRef}
                      className={
                        selectedConstructionPartId === "assembly" ||
                        selectedConstructionPartId === "collar"
                          ? "boothCanvas constructionSelected"
                          : "boothCanvas"
                      }
                      style={{
                        aspectRatio: `${selectedBooth.widthMm} / ${selectedBooth.depthMm}`,
                      }}
                      onPointerDown={() => {
                        setSelectedComponentId(
                          null
                        );
                        setSelectedConstructionPartId(null);

                        setEditorMessage(
                          ""
                        );
                      }}
                    >
                      {/* CARPET */}

                      <div className="carpetLayer">
                        <span className="carpetLabel">
                          KOBEREC 2000 × 2000
                        </span>
                      </div>

                      {/* FIXED CONSTRUCTION */}

                      {selectedBooth.id ===
                        "koje-2x2" && (
                        <>
                          <div
                            className={
                              selectedConstructionPartId === "back-wall"
                                ? "fixedWall backFixedWall selectedConstruction"
                                : "fixedWall backFixedWall"
                            }
                          >
                            <span>
                              2000
                            </span>
                          </div>

                          <div
                            className={
                              selectedConstructionPartId === "left-wall"
                                ? "fixedWall leftFixedWall selectedConstruction"
                                : "fixedWall leftFixedWall"
                            }
                          >
                            <span>
                              1000
                            </span>
                          </div>

                          <div
                            className={
                              selectedConstructionPartId === "right-wall"
                                ? "fixedWall rightFixedWall selectedConstruction"
                                : "fixedWall rightFixedWall"
                            }
                          >
                            <span>
                              1000
                            </span>
                          </div>

                          <div className="cornerProfile profileTopLeft" />
                          <div className="cornerProfile profileTopCenter" />
                          <div className="cornerProfile profileTopRight" />
                          <div className="cornerProfile profileLeftEnd" />
                          <div className="cornerProfile profileRightEnd" />
                        </>
                      )}

                      {/* COMPONENTS */}

                      {placedComponents.map(
                        (item) => {
                          const selected =
                            item.id ===
                            selectedComponentId;

                          return (
                            <button
                              key={
                                item.id
                              }
                              type="button"
                              className={[
                                "placedComponent",

                                item.type ===
                                "chair"
                                  ? "chairComponent"
                                  : "cabinetComponent",

                                selected
                                  ? "selected"
                                  : "",
                              ]
                                .filter(
                                  Boolean
                                )
                                .join(
                                  " "
                                )}
                              style={{
                                left: `${
                                  (item.xMm /
                                    selectedBooth.widthMm!) *
                                  100
                                }%`,

                                top: `${
                                  (item.yMm /
                                    selectedBooth.depthMm!) *
                                  100
                                }%`,

                                width: `${
                                  (item.widthMm /
                                    selectedBooth.widthMm!) *
                                  100
                                }%`,

                                height: `${
                                  (item.depthMm /
                                    selectedBooth.depthMm!) *
                                  100
                                }%`,

                                transform: `translate(-50%, -50%) rotate(${item.rotationDeg}deg)`,
                              }}
                              onPointerDown={(
                                event
                              ) =>
                                handleComponentPointerDown(
                                  event,
                                  item.id
                                )
                              }
                              onPointerMove={(
                                event
                              ) =>
                                handleComponentPointerMove(
                                  event,
                                  item.id
                                )
                              }
                              onPointerUp={
                                handleComponentPointerUp
                              }
                            >
                              {item.frontDirectionDeg !== undefined && (
                                <i
                                  className="frontMarker"
                                  style={{
                                    transform: `translateX(-50%) rotate(${item.frontDirectionDeg}deg)`,
                                  }}
                                >
                                  ▲
                                </i>
                              )}

                              <span className="placedComponentName">
                                {
                                  item.name
                                }
                              </span>

                              <small>
                                {
                                  item.widthMm
                                }{" "}
                                ×{" "}
                                {
                                  item.depthMm
                                }
                              </small>
                            </button>
                          );
                        }
                      )}
                    </div>

                    <div className="canvasLegend">
                      <div>
                        <span className="legendBox legendConstruction" />

                        Konstrukce – blokuje pohyb
                      </div>

                      <div>
                        <span className="legendBox legendComponent" />

                        Mobiliář
                      </div>

                      <div>
                        <span className="legendBox legendSelected" />

                        Vybraný objekt
                      </div>
                    </div>
                  </div>
                </section>

                {/* PROPERTIES */}

                <aside className="propertyPanel">
                  <div className="panelHeader">
                    <span>
                      VLASTNOSTI
                    </span>

                    <strong>
                      Projekt
                    </strong>
                  </div>

                  <ScenePanel
                    booth={selectedBooth}
                    variant={selectedVariant}
                    components={placedComponents}
                    selectedComponentId={selectedComponentId}
                    selectedConstructionPartId={selectedConstructionPartId}
                    onSelectComponent={selectSceneComponent}
                    onSelectConstructionPart={selectConstructionPart}
                  />

                  <div className="propertySection">
                    <div className="propertyRow">
                      <span>
                        Veletrh
                      </span>

                      <strong>
                        {selectedFair?.name ||
                          "—"}
                      </strong>
                    </div>

                    <div className="propertyRow">
                      <span>
                        Firma
                      </span>

                      <strong>
                        {company ||
                          "—"}
                      </strong>
                    </div>

                    <div className="propertyRow">
                      <span>
                        Konstrukce
                      </span>

                      <strong>
                        {
                          selectedBooth.code
                        }
                      </strong>
                    </div>

                    <div className="propertyRow">
                      <span>
                        Měna
                      </span>

                      <strong>
                        {
                          currency
                        }
                      </strong>
                    </div>
                  </div>

                  <div className="propertySection">
                    <span className="propertySectionTitle">
                      KONSTRUKCE
                    </span>

                    <div className="propertyRow">
                      <span>
                        Plocha
                      </span>

                      <strong>
                        2000 × 2000 mm
                      </strong>
                    </div>

                    <div className="propertyRow">
                      <span>
                        Výška
                      </span>

                      <strong>
                        2500 mm
                      </strong>
                    </div>

                    <div className="propertyRow">
                      <span>
                        Límec
                      </span>

                      <strong>
                        300 mm
                      </strong>
                    </div>

                    <div className="propertyRow">
                      <span>
                        Octanorm
                      </span>

                      <strong>
                        80 mm
                      </strong>
                    </div>

                    <div className="propertyRow">
                      <span>
                        Kolize
                      </span>

                      <strong className="statusEnabled">
                        Aktivní
                      </strong>
                    </div>
                  </div>

                  <div className="propertySection">
                    <span className="propertySectionTitle">
                      VYBRANÝ OBJEKT
                    </span>

                    {selectedPlacedComponent ? (
                      <>
                        <div className="selectedComponentCard">
                          <span>
                            {
                              selectedPlacedComponent.name
                            }
                          </span>

                          <strong>
                            {
                              selectedPlacedComponent.widthMm
                            }{" "}
                            ×{" "}
                            {
                              selectedPlacedComponent.depthMm
                            }{" "}
                            mm
                          </strong>
                        </div>

                        <div className="propertyRow">
                          <span>
                            X – střed
                          </span>

                          <strong>
                            {
                              selectedPlacedComponent.xMm
                            }{" "}
                            mm
                          </strong>
                        </div>

                        <div className="propertyRow">
                          <span>
                            Y – střed
                          </span>

                          <strong>
                            {
                              selectedPlacedComponent.yMm
                            }{" "}
                            mm
                          </strong>
                        </div>

                        <div className="propertyRow">
                          <span>
                            Rotace
                          </span>

                          <strong>
                            {
                              selectedPlacedComponent.rotationDeg
                            }
                            °
                          </strong>
                        </div>

                        <div className="propertyRow">
                          <span>
                            Režim
                          </span>

                          <strong>
                            {selectedPlacedComponent.rotation.locked
                              ? "Zamčená"
                              : selectedPlacedComponent.rotationMode === "free"
                                ? "Volná 360°"
                                : `Rychlé po ${selectedPlacedComponent.rotation.snapStep}°`}
                          </strong>
                        </div>

                        <div className="propertyRow">
                          <span>
                            Cenová skupina
                          </span>

                          <strong>
                            Mobiliář
                          </strong>
                        </div>

                        <button
                          className="inspectorDelete"
                          onClick={
                            deleteSelectedComponent
                          }
                        >
                          Smazat objekt
                        </button>
                      </>
                    ) : (
                      <p className="emptyInspector">
                        Klikni na mobiliář v půdorysu.
                      </p>
                    )}
                  </div>
                </aside>
              </div>

              {/* BOTTOM */}

              <PricingBar placedItemCount={placedComponents.length} />
            </div>
          )}
      </section>
    </main>
  );
}
