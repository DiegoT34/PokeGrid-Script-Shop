# Especificación: capturas de pantalla en la herramienta publicadora

**Fecha:** 2026-10-01
**Repositorio:** `DiegoT34/PokeGrid-Script-Shop` (herramienta publicadora)
**Estado:** aprobada por el usuario, pendiente de plan

---

## 1. Qué hay que conseguir

El launcher ya sabe mostrar hasta seis capturas de pantalla en la ficha de un script de la
Shop, y las baja del repositorio oficial. Lo que falta es el otro extremo: hoy el
publicador no sabe nada de capturas, así que quien publica tiene que copiaarlas a mano a
`screenshots/`, escribirlas en `catalog.json` a mano, y confiar en que el nombre y la URL
salen bien.

El trabajo de este proyecto es que el publicador **genere el nombre del archivo y la URL**,
y que avise de lo que no cumple en vez de publicarlo en silencio.

### Lo que NO es parte de este trabajo

- **No se toca la interfaz gráfica.** No hay selector de imágenes, ni arrastrar y soltar, ni
  vista previa. Las rutas entran por el parámetro `-Screenshots` de PowerShell, que ya
  existe como forma de invocar el publicador. La GUI queda intacta.
- **No se sube nada a GitHub desde aquí.** El publicador copia los archivos al árbol de
  trabajo y escribe el catálogo; el `git add`, `commit` y `push` siguen siendo los de
  siempre, que es donde ya viven.
- **No se cambia el launcher.** Este proyecto solo toca `PokeGrid-Script-Shop`.

---

## 2. El contrato que hay que cumplir

La fuente de verdad es `src/script-shop-screenshots.js` del launcher, función
`esCapturaDeShop`. Estas reglas son las que el launcher aplica, y el publicador tiene que
aplicar las mismas o el trabajo no sirve de nada:

| Regla | Detalle |
|---|---|
| **Host** | Exactamente `raw.githubusercontent.com`. Una ruta correcta con otro host se rechaza. |
| **Ruta** | `/DiegoT34/PokeGrid-Script-Shop/(main\|[a-f0-9]{40})/screenshots/<nombre>`, plana, sin subcarpetas. |
| **Prefijo** | El nombre empieza por `<id>-`. Con guion, siempre. `mi-herramienta.png` empieza por el id y **se rechaza**. |
| **Extensión** | `png`, `jpg`, `jpeg`, `webp`, `gif`, en cualquier mayúscula. Ojo: `jpg` y `jpeg` son el mismo grupo en el regex (`jpe?g`). |
| **Nombre** | Empieza por alfanumérico, luego `[a-z0-9._-]`, hasta 100 caracteres antes del punto. Sin espacios, tildes ni signos raros. **Las mayúsculas en el nombre se permiten**: el prefijo se compara en minúsculas, así que `Mi-Herramienta-1.PNG` es válida. |
| **URL** | Sin query string ni fragmento. |
| **Cantidad** | Hasta 6. |
| **Tamaño** | Hasta 2 MB cada una. |

`schemaVersion` del catálogo se queda en **1**. Si subiera, los launchers antiguos perderían
la Shop entera.

---

## 3. Decisiones

### D1 — El publicador genera el nombre; nunca lo pide

El nombre publicado es siempre `<id>-<n>.<ext>`, donde `<id>` es el id del script y `<n>` es
la posición, empezando en 1 y en el orden en que se pasaron las rutas.

**Por qué, y por qué no es purismo.** El prefijo con el id es lo que impide que un script se
apropie de las capturas de otro. Si el publicador respetara el nombre del archivo que el
usuario elige, esa protección no serviría de nada: bastaría con pasar
`otra-captura.png` para colgar la foto de otro script. El nombre del archivo original se
descarta por completo; solo se lee su **extensión**, y solo si es válida.

### D2 — Una captura que no cumple se descarta con aviso, y no tumba nada

Si una captura no pasa las reglas, el publicador la omite del catálogo, escribe un aviso
visible en el registro, y publica el resto.

Es la misma excepción deliberada que aplica el launcher, pero con una diferencia que
importa: allí el aviso va a la consola y la persona no está delante; aquí la persona sí, y
por eso el aviso tiene que verse.

**Lo que no puede pasar:** que una captura mala impida publicar un script. El script es lo
que se publica; la captura es decoración. Bloquear la publicación por un archivo mal puesto
sería un fallo de la herramienta, no una protección.

### D3 — Actualizar conserva las capturas existentes y sigue contando

Publicar una actualización sin pasar capturas **conserva** las que ya había, y si las había
avisa con su nombre y pregunta si se quieren quitar. Publicar con capturas nuevas las añade
a partir de la última, sin renumerar.

**Por qué conservar, y no reemplazar.** Si el publicador borrara las capturas que no se
mentionan, un descuido al no pasar el campo perdería las fotos de un script que llevaba
tiempo publicándose. Y si renumerara, una captura ya publicada cambiaría de URL y se rompería
en cualquier sitio donde estuviera enlazada.

**Por qué no basta con conservar en silencio.** El otro extremo del fallo es real: si publicas
una versión nueva y la foto ya no describe lo que el script hace, la ficha está mintiendo sin
avisar. Por eso conservar y avisar van juntos: las dos salidas que importan no pueden pasar en
silencio.

### D4 — El campo `screenshots` solo existe si hay capturas

Un script sin capturas no lleva el campo, ni un array vacío. Es lo que hace el script
publicador con el resto de campos opcionales, y mantiene el catálogo legible.

### D5 — Las cuatro piezas del catálogo se hacen explícitas

`git add` incluye `screenshots/`, el validador crece con una capa de capturas, y
`catalog.schema.json` declara el campo aunque `additionalProperties: true` lo permita.

**Lo que esto evita, que es el fallo más caro de este trabajo:** si `git add` no incluye la
carpeta, el commit sale bien, el publicador dice que todo está listo, y la URL del catálogo
apunta a imágenes que no están en GitHub. El fallo no aparece en la máquina de quien publica
—que es la que puede arreglarlo— sino en la de quien lee la Shop. Ninguna prueba de este
proyecto lo cazaría, porque todo lo demás es cierto.

### D6 — `catalog.schema.json` declara `screenshots` con su forma

El esquema es la documentación ejecutable del contrato. Declarar el campo aunque
`additionalProperties: true` lo permita no es necesario para que funcione: es necesario para
que quien lea el esquema sepa que el contrato incluye capturas y con qué reglas.

---

## 4. Qué hay que tocar

| Fichero | Cambio |
|---|---|
| `tools/publish-script.ps1` | Parámetro `-Screenshots`, copia, generación del nombre, campo en la entrada, avisos, restauración en caso de fallo. |
| `tools/validate-catalog.ps1` | Capa 4: capturas. Avisa, no lanza. |
| `PokeGrid-Shop-Publisher.ps1` | `git add` y `git commit` incluyen `screenshots/`. |
| `catalog.schema.json` | Campo `screenshots` con su tipo y su límite. |
| `.gitattributes` | `screenshots/* binary`. |
| `PUBLISHER-README.md` | Cómo se publican capturas. |
| `tools/test-*.ps1` | Pruebas nuevas. |

**Sobre `.gitattributes`:** el repo tiene `* text=auto eol=lf`, y sin una regla propia las
imágenes pasarían por esa conversión. Git las detecta como binarias por el contenido, pero
eso depende de que se detecten bien, y una imagen con un byte que parezca texto se lleva dos
conversiones de fin de línea que no le corresponden. Ponerlo explícito cuesta una línea y
quita la duda.

**Lo que NO cambia:** el nombre de los ficheros ya publicados, el flujo de publicación, el
`param()` de los scripts, la GUI, y el behaviour de `downloadUrl` (que sí lanza, porque sin
él no se puede instalar el script).

---

## 5. Errores y casos límite

| Situación | Qué pasa |
|---|---|
|más de 6 rutas | Se toman las 6 primeras y se avisa de cuántas se descartan. |
| Una ruta que no existe | Se descarta con aviso. |
| Extensión no válida | Se descarta con aviso. |
| Más de 2 MB | Se descarta con aviso, y el tamaño se comprueba **al copiar**, como en el launcher. |
| Un archivo ya existe con ese nombre | Se sobrescribe, que es lo normal al republicar la misma captura. |
| Publicar sin capturas cuando había | Se conservan y se avisa. |
| Un script que ya tenía capturas y pasa 6 nuevas | Se conservan las suyas y se descartan las 6 nuevas por el límite, con aviso. El total se queda en 6. |
| El nombre de la captura contiene espacios o tildes | Da igual: se descarta el nombre y se genera otro. Solo se lee la extensión. |
| `screenshots/` ya existe con archivos de otro script | No se tocan. Cada script tiene las suyas por prefijo. |
| La copia falla a mitad | Se restaura el estado anterior de la carpeta, igual que hoy se restaura el userscript. |
| La URL del script es inválida | **Lanza**, como hoy. Sin `downloadUrl` no se puede instalar. |

El patrón del rollback ya existe en `publish-script.ps1:146-163` y se extiende: si la
escritura del catálogo falla después de copiar algo, el árbol queda como estaba. Con capturas
eso importa más, porque un archivo de más en `screenshots/` sin entrada en el catálogo es
basura que se acumula.

---

## 6. Cómo se prueba

Este repo no tiene un runner como el del launcher; las pruebas son scripts de PowerShell en
`tools/` que se ejecutan uno a uno y se lanzan con un remoto temporal.

**El requisito, heredado del criterio que ya usa este proyecto:** una prueba que no se ha
saboteado no vale nada. Cada comprobación nueva lleva su sabotaje, con el rojo y el verde.

| Prueba | Tipo | Qué fija |
|---|---|---|
| `test-screenshots-publication.ps1` (nueva) | PowerShell | Que `-Screenshots` copia, genera `<id>-<n>.<ext>`, escribe las URLs y **no** copia nada si no se pasa el parámetro. |
| `test-screenshots-rejection.ps1` (nueva) | PowerShell | Extensión rara, tamaño excessive, ruta inexistente, más de 6, prefijo que no cuadra. Que se descarten **con aviso** y que el resto se publique. |
| `test-screenshots-update.ps1` (nueva) | PowerShell | Que actualizar sin capturas las conserva y avisa, y que al pasar nuevas sigue contando. |
| extender `test-validate-catalog.ps1` | PowerShell | Que la capa 4 acepta lo válido y avisa de lo que no, **sin lanzar**. |
| extender `test-git-workflow.ps1` | PowerShell | Que `git add` incluye `screenshots/` y que el commit lleva los archivos. |
| extender `test-catalog-schema.ps1` | PowerShell | Que `screenshots` está declarado y que un catálogo con él sigue siendo válido. |

**Sobre la última:** el fallo de `git add` no lo caza ninguna prueba de contenido, porque el
contenido está bien. Lo que hay que probar es el comando. Y sobre lo mismo: una prueba de que
el aviso aparece es tan importante como una de que el archivo se copia, porque un aviso que no
se ve es indistinguible de un aviso que no se dio.

---

## 7. Fuera de alcance

- **La GUI.** Ni selector de imágenes, ni arrastrar y soltar, ni vista previa.
- **Subir las capturas a otro sitio.** Se copian al árbol de trabajo; el `push` es el de
  siempre.
- **Redimensionar, recortar o recomprimir.** El launcher no lo hace con las suyas, y aquí
  menos. El límite de 2 MB es un filtro, no un objetivo.
- **Galería de portada o imagen de la tarjeta.** `icon` sigue siendo el emoji de 8
  caracteres, y el launcher no la usa como foto.
- **El launcher.** Cero cambios en `PokeGrid-Launcher`.
