(function () {
  'use strict';
  var camera = document.getElementById('camera-file');
  var upload = document.getElementById('receipt-file');
  var message = document.getElementById('photo-status');
  var start = document.getElementById('scan-start');
  var stop = document.getElementById('scan-stop');
  var scanner, running = false, busy = false;
  document.getElementById('take-photo').onclick = function () { camera.click(); };
  camera.onchange = function () { if (camera.files.length) { upload.value = ''; upload.required = false; message.textContent = 'Photo selected. Enter the merchant, date and total, then save.'; } };
  upload.onchange = function () { camera.value = ''; upload.required = true; message.textContent = upload.files.length ? 'Receipt selected. Enter the details, then save.' : ''; };
  document.getElementById('upload-form').addEventListener('reset', function () { upload.required = true; });
  window.prepareReceiptPhoto = async function (file) {
    if (file.type === 'application/pdf') return file;
    if (!file.type.startsWith('image/')) throw new Error('Choose a receipt image or PDF.');
    var url = URL.createObjectURL(file);
    try {
      var img = new Image();
      await new Promise(function (resolve, reject) { img.onload = resolve; img.onerror = function () { reject(new Error('Cannot read this photo. Try JPEG or PNG.')); }; img.src = url; });
      var canvas = document.createElement('canvas');
      var scale = Math.min(1, 1800 / Math.max(img.width, img.height));
      canvas.width = Math.max(1, Math.round(img.width * scale)); canvas.height = Math.max(1, Math.round(img.height * scale));
      var ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (var quality of [0.85, 0.65, 0.45, 0.25]) {
        var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', quality); });
        if (blob && blob.size <= 1000000) return new File([blob], 'receipt-photo.jpg', { type: 'image/jpeg' });
      }
      throw new Error('Photo is too large. Crop it closer to the receipt and try again.');
    } finally { URL.revokeObjectURL(url); }
  };
  function getScanner() {
    if (!window.Html5Qrcode) throw new Error('Scanner could not load. Check your connection or enter the code manually.');
    if (!scanner) scanner = new Html5Qrcode('barcode-reader');
    return scanner;
  }
  async function stopCamera() {
    if (running) { await scanner.stop(); running = false; }
    stop.hidden = true; start.disabled = false;
  }
  function decoded(value) {
    var claim = /^rct_[A-Za-z0-9_-]+$/.test(value) ? value : null;
    try { var url = new URL(value); if (url.protocol === 'https:' && ['reseats.org', 'www.reseats.org', 'reseats.com', 'www.reseats.com'].includes(url.hostname)) claim = url.searchParams.get('claim'); } catch (_) {}
    if (claim && claim.length >= 10 && claim.length <= 200) {
      document.getElementById('claim-token').value = claim;
      message.textContent = 'Receipt QR read. Tap Claim receipt to save it.';
    } else {
      document.getElementById('barcode').value = value.slice(0, 500);
      message.textContent = 'Barcode read. Attach a receipt photo and save it with your receipt details.';
    }
  }
  start.onclick = async function () {
    if (busy || running) return; busy = true; start.disabled = true;
    try {
      await getScanner().start({ facingMode: 'environment' }, { fps: 8 }, function (value) { decoded(value); stopCamera().catch(function () {}); }, function () {});
      running = true; stop.hidden = false;
    } catch (_) { message.textContent = 'Camera unavailable. Allow camera access, scan a saved image, or enter the code manually.'; start.disabled = false; }
    finally { busy = false; }
  };
  stop.onclick = function () { stopCamera().catch(function () { message.textContent = 'Could not stop scanner. Close this page to release the camera.'; }); };
  document.getElementById('scan-image').onchange = async function (event) {
    var file = event.target.files[0]; if (!file || busy) return;
    busy = true;
    try { await stopCamera(); decoded(await getScanner().scanFile(file, false)); }
    catch (_) { message.textContent = 'No readable barcode found. Try a clear, close photo or enter the code manually.'; }
    finally { busy = false; event.target.value = ''; }
  };
  document.addEventListener('visibilitychange', function () { if (document.hidden) stopCamera().catch(function () {}); });
  document.querySelectorAll('.tab').forEach(function (tab) { tab.addEventListener('click', function () { stopCamera().catch(function () {}); }); });
})();
