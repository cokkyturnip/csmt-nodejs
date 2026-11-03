# Perbaikan & Mitigasi Round 2

Tanggal: 2026-11-01  
Pelaksana: Agent Antigravity  
Status: **SELESAI & DIVERIFIKASI**

---

## Rincian Mitigasi Temuan Round 2

### 1. Perbaikan W1 (BLOCKER: Wizard Stdin Dual-Consumer & Hang)
- **File**: `src/cli.ts`
- **Tindakan**:
  1. **Satu Pemilik Stdin Eksklusif**: Menghapus listener `process.stdin.on("data")` terpisah dan menghapus panggilan `setRawMode(true)` manual yang bertabrakan dengan readline.
  2. **Async Line Queue**: Membuat antrean baris (`linesQueue`) dan daftar penunggu (`waiters`) yang mendengarkan event `rl.on("line")`. Pola ini menjamin tidak ada baris yang hilang (dropped) saat input dipipe sekaligus dan tidak ada hanging pada top-level await.
  3. **Muting Output Readline**: Melakukan muting pada `rl._writeToOutput` secara dinamis khusus saat membaca prompt password/secret (`isTTY && muted`), dan menuliskannya kembali ke fungsi asli segera setelah baris selesai diterima.
  4. **Penanganan SIGINT & Close**: Menambahkan `rl.on("SIGINT")` yang keluar dengan exit code 130 (sesuai spesifikasi dokumentasi), serta mereject promise penunggu dengan `ConfigError` jika stdin ditutup mendadak.
  5. **Regression Test**: Menambahkan pengujian otomatis wizard end-to-end di `tests/cli.test.ts`.

### 2. Verifikasi Hasil
- Pengujian otomatis PTY pada cabang `oauth2` dan `forms`:
  - Exit code: 0
  - Karakter password ter-masking (tidak bocor ke layar output)
  - File `.env` terbentuk lengkap dengan izin akses `0600`
- Pengujian piped input baris sekaligus (`printf ... | csmt wizard`):
  - Exit code: 0
  - Seluruh konfigurasi tersimpan tanpa error `unsettled top-level await`.
