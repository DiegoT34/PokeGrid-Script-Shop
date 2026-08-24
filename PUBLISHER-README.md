# PokeGrid Shop Publisher 1.1.2 para Windows

La interfaz adaptable organiza la publicación en tres pasos, detecta automáticamente si el archivo corresponde a una actualización existente y muestra una vista previa de la tarjeta antes de publicarla.

## Abrir

Haz doble clic en `Abrir-PokeGrid-Shop-Publisher.cmd`.

## Requisitos

- Windows 10 u 11.
- Git instalado.
- GitHub CLI instalado y autorizado como `DiegoT34`.

Para autorizar GitHub CLI por primera vez:

```powershell
gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git
```

## Publicar o actualizar

1. Arrastra el userscript sobre la ventana o pulsa **Examinar**.
2. La aplicación leerá los metadatos automáticamente.
3. Conserva el mismo **ID estable** cuando sea una actualización.
4. Completa categoría, etiquetas, resumen, descripción, permisos y changelog.
5. Revisa la vista previa y pulsa **Validar**.
6. Pulsa **Publicar en la Shop** o **Publicar actualización**.

La aplicación sincronizará el repositorio, copiará el script, normalizará la versión si es necesario, calculará SHA-256, actualizará el catálogo, creará el commit, hará `git push` y comprobará que la versión ya sea visible online.

GitHub Actions validará nuevamente el catálogo. Si el proceso termina correctamente, los usuarios podrán verlo con **Scripts → Shop online → Verificar**.

## Corrección 1.1.1

- Corrige el desbordamiento de profundidad causado por la función interna que ocultaba a `git.exe`.
- Ejecuta siempre la ruta real de Git y evita solicitudes de credenciales ocultas detrás de la interfaz.
- Incluye `tools\test-git-workflow.ps1`, que valida pull, add, commit y push contra un remoto temporal.
- Incluye `tools\test-publication-pipeline.ps1`, que valida catálogo, versión y SHA-256 sin publicar nada.

## Corrección 1.1.2

- Guarda `catalog.json` en UTF-8 sin BOM para que el launcher pueda leerlo con `JSON.parse()`.
