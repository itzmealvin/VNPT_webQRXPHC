const DEFAULTS = {
  BANK_ID: "970415",
  ACCOUNT_NO: "1059384921",
  ACCOUNT_NAME: "Trung tam Phuc vu Hanh chinh cong phuong Nha Trang",
  TEMPLATE: "compact2",
};

const QR_NOTICE_TEXT =
  "Để thuận tiện giao dịch, Ông/Bà vui lòng sử dụng mã QR kèm theo Quyết định này và kiểm tra kỹ \n thông tin trước khi thanh toán.";

const LIMITS = {
  MAX_FILE_SIZE: 20 * 1024 * 1024,
  QR_SCALE: 0.3,
};

const $ = (id) => document.getElementById(id);

const el = {
  pdfInput: $("pdfInput"),
  uploadToggleBtn: $("uploadToggleBtn"),
  downloadBtn: $("downloadBtn"),
  generateQrBtn: $("generateQrBtn"),
  pdfCanvas: $("pdfCanvas"),
  pdfPreviewWrap: $("pdfPreviewWrap"),
  previewPlaceholder: $("previewPlaceholder"),
  pageInfo: $("pageInfo"),
  prevPageBtn: $("prevPageBtn"),
  nextPageBtn: $("nextPageBtn"),
  docInfoCollapse: $("docInfoCollapse"),
  decisionNo: $("decisionNo"),
  amount: $("amount"),
  bankId: $("bankId"),
  bankSelect: $("bankSelect"),
  accountNo: $("accountNo"),
  template: $("template"),
  accountName: $("accountName"),
  description: $("description"),
  qrImage: $("qrImage"),
  qrPlaceholder: $("qrPlaceholder"),
  ocrOverlay: $("ocrOverlay"),
  amountText: $("amountText"),
  descText: $("descText"),
};

const state = {
  pdfBytes: null,
  pdfDoc: null,
  currentPage: 1,
  qrUrl: "",
  banks: [],
  bankTomSelect: null,
  resizeTimer: null,
  renderSeq: 0,
};

const pdfjsLib =
  await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@5.7.284/build/pdf.min.mjs");
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.7.284/build/pdf.worker.min.mjs";

toastr.options = {
  closeButton: true,
  progressBar: true,
  positionClass: "toast-top-right",
  timeOut: 2500,
};

function normalizeAmount(value) {
  return (value || "").replace(/[^\d]/g, "");
}

function formatAmountWithSpaces(value) {
  const digits = normalizeAmount(value);
  return digits ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ") : "";
}

function sanitizeFileName(name) {
  return name.replace(/\.pdf$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function createNoticeImageBytes(
  text,
  { widthPt = 500, fontSizePt = 10, scale = 4 } = {},
) {
  const width = Math.round(widthPt * scale);
  const margin = Math.round(12 * scale);
  const fontSize = Math.round(fontSizePt * scale);
  const lineHeight = Math.round(fontSize * 1.35);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Không thể tạo canvas để chèn nội dung.");

  ctx.font = `italic ${fontSize}px "Times New Roman", serif`;
  const maxTextWidth = width - margin * 2;
  const lines = [];
  const paragraphs = text.split(/\r?\n/);

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) {
      lines.push("");
      continue;
    }
    const words = trimmed.split(/\s+/);
    let currentLine = "";

    for (const word of words) {
      const nextLine = currentLine ? `${currentLine} ${word}` : word;
      if (ctx.measureText(nextLine).width <= maxTextWidth) {
        currentLine = nextLine;
        continue;
      }
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
    if (currentLine) lines.push(currentLine);
  }

  const height = margin * 2 + lines.length * lineHeight;
  canvas.width = width;
  canvas.height = height;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#000000";
  ctx.font = `italic ${fontSize}px "Times New Roman", serif`;
  ctx.textBaseline = "top";
  ctx.textAlign = "center";

  lines.forEach((line, idx) => {
    ctx.fillText(line, width / 2, margin + idx * lineHeight);
  });

  const dataUrl = canvas.toDataURL("image/png");
  const response = await fetch(dataUrl);
  return response.arrayBuffer();
}

function getOutputFileName() {
  const name = el.pdfInput.files?.[0]?.name || "output";
  return `${sanitizeFileName(name)}_VietQR.pdf`;
}

function buildDefaultDescription() {
  const decisionNo = el.decisionNo.value.trim();
  return decisionNo
    ? `Nop XPHC theo QD so ${decisionNo}`
    : "Nop XPHC theo QD so";
}

function showOcrOverlay() {
  el.ocrOverlay.classList.remove("d-none");
}

function hideOcrOverlay() {
  el.ocrOverlay.classList.add("d-none");
}

function resetQrPreview() {
  state.qrUrl = "";
  el.qrImage.classList.add("d-none");
  el.qrImage.removeAttribute("src");
  el.qrPlaceholder.classList.remove("d-none");
}

function collapseDocInfo() {
  if (!el.docInfoCollapse) return;
  try {
    if (window.bootstrap?.Collapse) {
      const collapse = window.bootstrap.Collapse.getOrCreateInstance(
        el.docInfoCollapse,
        { toggle: false },
      );
      collapse.hide();
    } else {
      el.docInfoCollapse.classList.remove("show");
    }
  } catch {
    el.docInfoCollapse.classList.remove("show");
  }
}

function setButtonsState() {
  const hasPdf = !!state.pdfBytes;
  if (el.uploadToggleBtn) {
    el.uploadToggleBtn.textContent = hasPdf ? "Đặt lại" : "Tải lên Quyết định";
    el.uploadToggleBtn.classList.toggle("btn-danger", hasPdf);
    el.uploadToggleBtn.classList.toggle("btn-primary", !hasPdf);
  }
  el.generateQrBtn.disabled = !hasPdf;
  el.downloadBtn.disabled = !hasPdf || !state.qrUrl;
  el.prevPageBtn.disabled = !hasPdf || state.currentPage <= 1;
  el.nextPageBtn.disabled =
    !hasPdf || !state.pdfDoc || state.currentPage >= state.pdfDoc.numPages;
}

function updatePaymentSummary() {
  el.amountText.textContent = formatAmountWithSpaces(el.amount.value) || "0";
  el.descText.textContent = el.description.value.trim() || "-";
}

function setupDefaults() {
  el.accountNo.value = DEFAULTS.ACCOUNT_NO;
  el.accountName.value = DEFAULTS.ACCOUNT_NAME;
  el.template.value = DEFAULTS.TEMPLATE;
}

function bankLabel(bank) {
  return `${bank.name} (${bank.shortName}) - ${bank.bin}`;
}

function initBankTomSelect() {
  if (state.bankTomSelect) {
    state.bankTomSelect.destroy();
    state.bankTomSelect = null;
  }

  state.bankTomSelect = new TomSelect(el.bankSelect, {
    options: state.banks.map((bank) => ({
      value: String(bank.bin),
      text: bankLabel(bank),
      shortName: bank.shortName,
      name: bank.name,
      bin: String(bank.bin),
      logo: bank.logo || "",
    })),
    valueField: "value",
    labelField: "text",
    searchField: ["shortName", "bin", "text", "name"],
    maxItems: 1,
    create: false,
    allowEmptyOption: false,
    placeholder: "Chọn ngân hàng",
    render: {
      option(data, escape) {
        return `<div class="bank-item"><img src="${escape(data.logo)}" alt="${escape(data.shortName)}" class="bank-logo-sm" /><span>${escape(data.name)} (${escape(data.shortName)}) - ${escape(data.bin)}</span></div>`;
      },
      item(data, escape) {
        return `<div class="bank-selected-wrap"><img src="${escape(data.logo)}" alt="${escape(data.shortName)}" class="bank-logo-sm" /><span>${escape(data.name)} (${escape(data.shortName)}) - ${escape(data.bin)}</span></div>`;
      },
    },
    onChange(value) {
      el.bankId.value = value ? String(value) : "";
    },
  });
}

function setDefaultBankSelection() {
  const defaultBin = String(
    (
      state.banks.find((b) => String(b.bin) === DEFAULTS.BANK_ID) ||
      state.banks[0]
    )?.bin || "",
  );

  if (defaultBin && state.bankTomSelect) {
    state.bankTomSelect.setValue(defaultBin, true);
    el.bankId.value = defaultBin;
  }
}

async function loadBanksFromJson() {
  try {
    const response = await fetch("./banks.json", { cache: "no-store" });
    if (!response.ok)
      throw new Error(`banks.json load failed: ${response.status}`);

    const payload = await response.json();
    const list = Array.isArray(payload?.data) ? payload.data : [];
    state.banks = list.filter((b) => b && b.bin && b.shortName && b.logo);

    initBankTomSelect();
    setDefaultBankSelection();
  } catch (error) {
    console.error(error);
    el.bankId.value = DEFAULTS.BANK_ID;
    el.bankSelect.innerHTML = `<option value="${DEFAULTS.BANK_ID}">Mặc định: ${DEFAULTS.BANK_ID}</option>`;
    initBankTomSelect();
    if (state.bankTomSelect)
      state.bankTomSelect.setValue(DEFAULTS.BANK_ID, true);
    toastr.warning("Không tải được danh sách ngân hàng.");
  }
}

async function renderPage(pageNumber) {
  if (!state.pdfDoc) return;
  const renderId = ++state.renderSeq;

  const page = await state.pdfDoc.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const availableWidth = Math.max(120, el.pdfPreviewWrap.clientWidth - 2);
  const fitScale = availableWidth / baseViewport.width;
  const viewport = page.getViewport({ scale: fitScale });
  const ctx = el.pdfCanvas.getContext("2d");
  if (!ctx) return;

  el.pdfCanvas.width = Math.round(viewport.width);
  el.pdfCanvas.height = Math.round(viewport.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  if (renderId !== state.renderSeq) return;

  el.previewPlaceholder.classList.add("d-none");
  el.pageInfo.textContent = `Trang ${state.currentPage} / ${state.pdfDoc.numPages}`;
  setButtonsState();
}

async function loadPdf(file) {
  if (file.type !== "application/pdf") {
    toastr.error("Chỉ hỗ trợ tệp PDF.");
    return false;
  }
  if (file.size > LIMITS.MAX_FILE_SIZE) {
    toastr.error("Tệp vượt quá 20MB.");
    return false;
  }

  const rawBytes = await file.arrayBuffer();
  state.pdfBytes = new Uint8Array(rawBytes);
  state.pdfDoc = await pdfjsLib.getDocument({ data: state.pdfBytes.slice() })
    .promise;
  state.currentPage = 1;

  await renderPage(state.currentPage);
  resetQrPreview();
  toastr.success("Đã tải lên PDF thành công.");
  return true;
}

async function extractFieldsFromPdf(file) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch("/api/extract", {
    method: "POST",
    body: formData,
  });
  if (!response.ok) throw new Error(`Extract thất bại: ${response.status}`);

  const json = await response.json();
  return {
    soQD: json.fields?.soQD || "",
    soTien: json.fields?.soTien || "",
  };
}

function getPdfBaseName(fileName) {
  return sanitizeFileName(fileName || "uploaded");
}

async function extractFieldsFromPdfFile(fileName) {
  if (!state.pdfBytes) throw new Error("PDF chưa sẵn sàng để OCR");

  const baseName = getPdfBaseName(fileName);
  const pdfFile = new File([state.pdfBytes], `${baseName}.pdf`, {
    type: "application/pdf",
  });
  return extractFieldsFromPdf(pdfFile);
}

async function ocrAllPagesAndExtract(file) {
  if (!state.pdfDoc || !state.pdfBytes) {
    toastr.warning("Vui lòng tải lên PDF trước.");
    return;
  }

  showOcrOverlay();

  try {
    const { soQD, soTien } = await extractFieldsFromPdfFile(file.name);

    if (soQD) el.decisionNo.value = soQD;
    if (soTien) el.amount.value = formatAmountWithSpaces(soTien);

    el.description.value = buildDefaultDescription();
    updatePaymentSummary();
    await renderPage(state.currentPage);

    if (!soQD && !soTien) {
      toastr.warning(
        "Không tìm thấy rõ 'Số:' hoặc 'Số tiền:'. Vui lòng nhập tay.",
      );
    } else {
      toastr.success("Trích xuất dữ liệu thành công.");
    }
  } catch (error) {
    console.error(error);
    toastr.error(
      `Trích xuất thất bại: ${error?.message || "Vui lòng thử lại."}`,
    );
  } finally {
    hideOcrOverlay();
  }
}

function buildVietQrUrl() {
  const bankId = el.bankId.value.trim();
  const accountNo = el.accountNo.value.trim();
  const template = el.template.value.trim() || DEFAULTS.TEMPLATE;
  const amount = normalizeAmount(el.amount.value.trim());
  const accountName = el.accountName.value.trim();
  const description = el.description.value.trim();

  if (!bankId || !accountNo || !amount || !accountName) {
    toastr.warning(
      "Thiếu thông tin ngân hàng, số tài khoản, số tiền hoặc tên tài khoản. Vui lòng điền đầy đủ.",
    );
    return "";
  }

  const base = `https://img.vietqr.io/image/${encodeURIComponent(bankId)}-${encodeURIComponent(accountNo)}-${encodeURIComponent(template)}.png`;
  const query = new URLSearchParams({
    amount,
    addInfo: description || buildDefaultDescription(),
    accountName,
  });

  return `${base}?${query.toString()}`;
}

function previewQr(url) {
  state.qrUrl = url;
  el.qrImage.src = url;

  el.qrImage.onload = () => {
    el.qrImage.classList.remove("d-none");
    el.qrPlaceholder.classList.add("d-none");
    collapseDocInfo();
    toastr.success("Tạo VietQR thành công.");
    setButtonsState();
  };

  el.qrImage.onerror = () => {
    resetQrPreview();
    toastr.error("Không thể tạo VietQR.");
    setButtonsState();
  };
}

async function generateQr() {
  alert(
    "Vui lòng kiểm tra kỹ thông tin trước khi tạo VietQR để tránh sai sót!",
  );

  if (!state.pdfDoc) {
    toastr.warning("Vui lòng tải lên PDF trước.");
    return;
  }

  if (!el.description.value.trim()) {
    el.description.value = buildDefaultDescription();
  }

  const qrUrl = buildVietQrUrl();
  if (!qrUrl) return;

  previewQr(qrUrl);
  updatePaymentSummary();
}

async function savePdfBlob(blob, fileName) {
  if ("showSaveFilePicker" in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [
          {
            description: "PDF Document",
            accept: { "application/pdf": [".pdf"] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function embedQrAndDownload() {
  if (!state.pdfBytes || !state.qrUrl) {
    toastr.warning("Cần có PDF và VietQR trước khi tải xuống.");
    return;
  }

  el.downloadBtn.disabled = true;

  try {
    const pdfDocLib = await PDFLib.PDFDocument.load(state.pdfBytes.slice());
    const pages = pdfDocLib.getPages();
    const lastPage = pages[pages.length - 1];
    if (!lastPage) throw new Error("PDF has no pages");

    const qrResponse = await fetch(state.qrUrl);
    if (!qrResponse.ok)
      throw new Error(`Tải ảnh VietQR thất bại: ${qrResponse.status}`);

    const qrBytes = await qrResponse.arrayBuffer();
    const pngImage = await pdfDocLib.embedPng(qrBytes);

    const qrWidth = pngImage.width * LIMITS.QR_SCALE;
    const qrHeight = pngImage.height * LIMITS.QR_SCALE;
    const { width: pageWidth, height: pageHeight } = lastPage.getSize();
    const x = Math.max(0, (pageWidth - qrWidth) / 2);
    const y = Math.max(0, (pageHeight - qrHeight) / 2 + 20);

    const noticeWidth = Math.max(120, pageWidth - 80);
    const noticeImageBytes = await createNoticeImageBytes(QR_NOTICE_TEXT, {
      widthPt: noticeWidth,
      fontSizePt: 10,
      scale: 4,
    });
    const noticeImage = await pdfDocLib.embedPng(noticeImageBytes);
    const noticeScale = noticeWidth / noticeImage.width;
    const noticeHeight = noticeImage.height * noticeScale;

    lastPage.drawImage(noticeImage, {
      x: (pageWidth - noticeWidth) / 2,
      y: Math.max(12, y - noticeHeight - 12),
      width: noticeWidth,
      height: noticeHeight,
    });

    lastPage.drawImage(pngImage, { x, y, width: qrWidth, height: qrHeight });

    const outBytes = await pdfDocLib.save();
    const blob = new Blob([outBytes], { type: "application/pdf" });
    await savePdfBlob(blob, getOutputFileName());

    toastr.success("Tải xuống PDF thành công.");
  } catch (error) {
    if (error?.name === "AbortError") {
      toastr.info("Đã hủy tải xuống PDF.");
      return;
    }
    console.error(error);
    toastr.error(
      `Không thể chèn VietQR vào PDF: ${error?.message || "Unknown error"}`,
    );
  } finally {
    setButtonsState();
  }
}

function resetForm() {
  el.pdfInput.value = "";
  state.pdfBytes = null;
  state.pdfDoc = null;
  state.currentPage = 1;

  el.decisionNo.value = "";
  el.amount.value = "";
  el.description.value = "";
  setupDefaults();

  if (state.bankTomSelect) {
    state.bankTomSelect.clear(true);
    setDefaultBankSelection();
  } else {
    el.bankId.value = DEFAULTS.BANK_ID;
  }

  const ctx = el.pdfCanvas.getContext("2d");
  if (ctx) ctx.clearRect(0, 0, el.pdfCanvas.width, el.pdfCanvas.height);

  el.previewPlaceholder.textContent =
    'Chưa có tệp nào. Nhấn nút "Tải lên PDF Quyết định" để bắt đầu';
  el.previewPlaceholder.classList.remove("d-none");
  el.pageInfo.textContent = "Trang 0 / 0";

  resetQrPreview();
  el.amountText.textContent = "0";
  el.descText.textContent = "-";

  hideOcrOverlay();
  setButtonsState();
  toastr.info("Đã đặt lại biểu mẫu.");
}

function attachEvents() {
  el.uploadToggleBtn.addEventListener("click", () => {
    if (state.pdfBytes) {
      resetForm();
      return;
    }
    el.pdfInput.click();
  });

  el.pdfInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const loaded = await loadPdf(file);
    if (!loaded) return;

    await ocrAllPagesAndExtract(file);
    setButtonsState();
  });

  el.prevPageBtn.addEventListener("click", async () => {
    if (!state.pdfDoc || state.currentPage <= 1) return;
    state.currentPage -= 1;
    await renderPage(state.currentPage);
  });

  el.nextPageBtn.addEventListener("click", async () => {
    if (!state.pdfDoc || state.currentPage >= state.pdfDoc.numPages) return;
    state.currentPage += 1;
    await renderPage(state.currentPage);
  });

  el.generateQrBtn.addEventListener("click", generateQr);
  el.downloadBtn.addEventListener("click", embedQrAndDownload);

  el.decisionNo.addEventListener("input", () => {
    el.description.value = buildDefaultDescription();
    updatePaymentSummary();
  });

  el.amount.addEventListener("input", () => {
    el.amount.value = normalizeAmount(el.amount.value);
    updatePaymentSummary();
  });

  el.amount.addEventListener("blur", () => {
    el.amount.value = formatAmountWithSpaces(el.amount.value);
    updatePaymentSummary();
  });

  el.description.addEventListener("input", updatePaymentSummary);

  window.addEventListener("resize", () => {
    if (!state.pdfDoc) return;
    if (state.resizeTimer) window.clearTimeout(state.resizeTimer);
    state.resizeTimer = window.setTimeout(() => {
      renderPage(state.currentPage).catch(console.error);
    }, 120);
  });
}

setupDefaults();
await loadBanksFromJson();
updatePaymentSummary();
setButtonsState();
attachEvents();
