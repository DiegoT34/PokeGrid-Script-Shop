# PokeGrid Shop Publisher para Windows

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

1. Pulsa **Examinar** y selecciona el script.
2. La aplicación leerá los metadatos automáticamente.
3. Conserva el mismo **ID estable** cuando sea una actualización.
4. Completa categoría, etiquetas, resumen, descripción, permisos y changelog.
5. Pulsa **Validar**.
6. Pulsa **Publicar / Actualizar**.

La aplicación sincronizará el repositorio, copiará el script, normalizará la versión si es necesario, calculará SHA-256, actualizará el catálogo, creará el commit y hará `git push`.

GitHub Actions validará nuevamente el catálogo. Si el proceso termina correctamente, los usuarios podrán verlo con **Scripts → Shop online → Verificar**.
