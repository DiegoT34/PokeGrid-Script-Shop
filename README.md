# PokeGrid Script Shop

Catálogo oficial de scripts descargables para **PokeGrid Launcher**.

El launcher consulta `catalog.json` cuando el usuario abre **Scripts → Shop online**. Cada descarga se limita al repositorio `DiegoT34/PokeGrid-Script-Shop` y se verifica mediante SHA-256 antes de instalarse.

## Publicación rápida

1. Añade el archivo `.user.js` a `scripts/`.
2. Comprueba que declara `@name`, `@namespace` y `@version X.Y.Z`.
3. Calcula su hash:

   ```powershell
   (Get-FileHash -LiteralPath '.\scripts\mi-script.user.js' -Algorithm SHA256).Hash.ToLowerInvariant()
   ```

4. Añade o actualiza su entrada en `catalog.json`.
5. Confirma los cambios. La validación automática impedirá publicar versiones, namespaces, URLs o hashes inconsistentes.

La guía detallada está en el repositorio del launcher: [Publicar scripts en PokeGrid Script Shop](https://github.com/DiegoT34/PokeGrid-Launcher/blob/main/docs/SCRIPT_SHOP.md).

## Actualizaciones

Mantén estables el `id`, el nombre del archivo y `@namespace`. Incrementa `@version`, sustituye el SHA-256 del catálogo y describe el cambio en `changelog`. El launcher mostrará la actualización sin modificar las cuentas seleccionadas ni el estado activo del usuario.

## Privacidad

No publiques claves, tokens, cookies, credenciales ni información de cuentas. Los scripts publicados son código público que los usuarios pueden inspeccionar antes y después de instalarlos.
