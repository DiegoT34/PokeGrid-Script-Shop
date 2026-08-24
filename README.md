# PokeGrid Script Shop

Catálogo oficial de scripts descargables para **PokeGrid Launcher**.

El launcher consulta `catalog.json` cuando el usuario abre **Scripts → Shop online**. Cada descarga se limita al repositorio `DiegoT34/PokeGrid-Script-Shop` y se verifica mediante SHA-256 antes de instalarse.

## Publicador gráfico para Windows

Ejecuta `Abrir-PokeGrid-Shop-Publisher.cmd` para abrir la aplicación gráfica. Permite:

- seleccionar cualquier `.js` o `.user.js` con cabecera userscript;
- leer automáticamente nombre, namespace, versión, autor y descripción;
- completar categoría, etiquetas, permisos, icono y changelog;
- crear o actualizar el archivo publicado;
- normalizar versiones de dos componentes, como `3.91`, a `3.91.0`;
- calcular y guardar el SHA-256;
- actualizar `catalog.json`;
- crear el commit y ejecutar `git push`.

Si la aplicación se ejecuta desde el ZIP portátil del publicador, preparará una copia Git de la Shop en `%LOCALAPPDATA%\PokeGrid-Shop-Publisher\repository`. Git y GitHub CLI deben estar instalados y GitHub CLI debe estar autorizado con la cuenta `DiegoT34`.

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
