// 載入車體定位模型與車牌字元模型
import { useState, useRef, useEffect } from "react";
import { loadCarModel, loadCharModel } from "../services/models";

export function useModels() {
  const carModelRef = useRef(null);
  const charModelRef = useRef(null);
  const [modelReady, setModelReady] = useState(false);
  const [modelError, setModelError] = useState(false);
  const [charModelReady, setCharModelReady] = useState(false);
  const [charModelError, setCharModelError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const model = await loadCarModel();
        if (!cancelled) {
          carModelRef.current = model;
          setModelReady(true);
        }
      } catch (err) {
        console.error("車體模型載入失敗：", err);
        if (!cancelled) setModelError(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const charModel = await loadCharModel();
        if (!cancelled) {
          charModelRef.current = charModel;
          setCharModelReady(true);
        }
      } catch (err) {
        console.error("字元辨識模型載入失敗：", err);
        if (!cancelled) setCharModelError(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { carModelRef, charModelRef, modelReady, modelError, charModelReady, charModelError };
}
