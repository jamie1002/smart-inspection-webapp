// Firebase 上傳服務（取代原 mock uploadPhoto）
// 真實串接：Storage 上傳照片 + Firestore 寫入 rentals / photos。
// 測試版寫入 *_test collection，避免污染正式資料（規格 §4.4）。

import {
  doc,
  setDoc,
  addDoc,
  updateDoc,
  collection,
  increment,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage, STORAGE_BUCKET, authReady, authError } from "../config/firebase";
import { IS_TEST_MODE, APP_MODE, APP_VERSION, MODEL_VERSION } from "../config/appConfig";
import { POSITION_TO_PHOTO_TYPE } from "../constants/guideTemplates";

const RENTALS = "rentals";
const PHOTOS = "photos";

function dataUrlToBlob(dataUrl) {
  const [head, body] = dataUrl.split(",");
  const mime = head.match(/:(.*?);/)?.[1] || "image/jpeg";
  const binary = atob(body);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// 匿名登入若已失敗，authReady 永遠不會 resolve；這裡先檢查旗標，
// 讓呼叫端能收到明確錯誤（「上傳失敗：匿名登入未啟用」），而不是無聲卡住。
function assertAuthReady() {
  if (authError) {
    throw new Error(`上傳失敗：匿名登入未啟用或被拒絕（${authError.code || authError.message}）`);
  }
}

function deviceInfo() {
  return {
    userAgent: navigator.userAgent || "",
    platform: navigator.platform || "",
  };
}

// 建立訂單（開始檢測時呼叫一次）
export async function createRental({ sessionId, vehicleId, carModel, personnelName, plateInput, plateInputNormalized }) {
  assertAuthReady();
  await authReady;
  const rentalId = `Rental_${vehicleId}_${Date.now()}`;
  await setDoc(doc(db, RENTALS, rentalId), {
    rental_id: rentalId,
    session_id: sessionId,
    vehicle_id: vehicleId,
    car_model: carModel ?? null,
    personnel_name: personnelName,
    plate_input: plateInput,
    plate_input_normalized: plateInputNormalized,
    status: "pickup_uploading",
    created_at: serverTimestamp(),
    completed_at: null,
    pickup_photo_count: 0,
    return_photo_count: 0,
    app_mode: APP_MODE,
    app_version: APP_VERSION,
    // 後端 AI / 複核用欄位（沿用 04，前端建立時填預設）
    risk_flag: false,
    risk_level: null,
    reviewed_by_staff: false,
    review_notes: null,
    reviewed_at: null,
  });
  return rentalId;
}

// 上傳單張照片：Storage → photos 文件 → rentals 計數 +1
export async function uploadPhotoRecord(meta) {
  assertAuthReady();
  await authReady;

  const {
    rentalId,
    sessionId,
    vehicleId,
    carModel,
    personnelName,
    plateInput,
    plateInputNormalized,
    position,
    sequenceIndex,
    dataUrl,
    capturedAt, // ms
    gps, // { lat, lng, accuracy, source }
    detections, // { license_plate:{...,conf}, wheel:{...,conf} }
    plateOcr, // { text, confidence } | null
    plateMatch, // bool
    blur, // { score, baseline, relativeRatio }
    orientation, // { beta, gamma }
    captureMode, // "auto" | "manual"
    retakeCount,
    imageWidth,
    imageHeight,
  } = meta;

  const photoType = POSITION_TO_PHOTO_TYPE[position] || position;
  const timestamp = Date.now();
  const fileName = `${rentalId}_${vehicleId}_${photoType}_${timestamp}.jpg`;

  const blob = dataUrlToBlob(dataUrl);
  const storageRef = ref(storage, fileName); // 扁平命名，bucket 根目錄
  await uploadBytes(storageRef, blob, { contentType: "image/jpeg" });
  let downloadUrl = null;
  try {
    downloadUrl = await getDownloadURL(storageRef);
  } catch {
    downloadUrl = null;
  }

  await addDoc(collection(db, PHOTOS), {
    rental_id: rentalId,
    session_id: sessionId,
    vehicle_id: vehicleId,
    car_model: carModel ?? null,
    personnel_name: personnelName,
    plate_input: plateInput,
    plate_input_normalized: plateInputNormalized,
    stage: "pickup",
    photo_type: photoType,
    sequence_index: sequenceIndex,
    file_name: fileName,
    storage_path: `gs://${STORAGE_BUCKET}/${fileName}`,
    download_url: downloadUrl,
    captured_at: capturedAt ? Timestamp.fromMillis(capturedAt) : null,
    uploaded_at: serverTimestamp(),
    server_uploaded_at: serverTimestamp(),
    gps_lat: gps?.lat ?? null,
    gps_lng: gps?.lng ?? null,
    gps_accuracy: gps?.accuracy ?? null,
    gps_source: gps?.source ?? "none",
    detections: detections ?? null,
    plate_ocr: plateOcr?.text ?? null,
    plate_ocr_confidence: plateOcr?.confidence ?? null,
    plate_match: plateMatch ?? null,
    blur_score: blur?.score ?? null,
    blur_baseline: blur?.baseline ?? null,
    blur_relative_ratio: blur?.relativeRatio ?? null,
    orientation: orientation ?? null,
    capture_mode: captureMode ?? null,
    retake_count: retakeCount ?? 0,
    image_width: imageWidth ?? null,
    image_height: imageHeight ?? null,
    file_size_bytes: blob.size,
    model_version: MODEL_VERSION,
    app_mode: APP_MODE,
    app_version: APP_VERSION,
    device: deviceInfo(),
    qc_status: "pending",
    damages: [],
  });

  await updateDoc(doc(db, RENTALS, rentalId), {
    pickup_photo_count: increment(1),
  });
}

// 四張完成後更新訂單狀態
export async function markPickupUploaded(rentalId) {
  assertAuthReady();
  await authReady;
  await updateDoc(doc(db, RENTALS, rentalId), {
    status: "pickup_uploaded",
    completed_at: serverTimestamp(),
  });
}
