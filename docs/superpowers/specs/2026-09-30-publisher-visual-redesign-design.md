# Especificación: Rediseño visual del PokeGrid Publisher con cristal, temas y animaciones

**Fecha:** 2026-09-30
**Estado:** aprobado para implementación
**Alcance:** solo la capa visual de `PokeGrid-Shop-Publisher.ps1`. Ninguna lógica de publicación cambia.

---

## 1. Objetivo y restricción dominante

Rehacer por completo el aspecto del publicador: cristal, jerarquía tipográfica, botones,
paneles, animaciones y varios temas, **sin alterar el comportamiento**.

La restricción que manda sobre todas las demás:

> **La lógica de publicación, retirada, detección de actualizaciones, validación de versión
> del launcher y sincronización con Git no cambian ni una línea.**

Eso incluye los nombres de función, los parámetros, los mensajes, los flujos del panel de
log y los códigos de salida. El smoke test existente debe seguir en verde sin modificarse,
salvo por las aserciones visuales nuevas que se le añadan.

## 2. Constantes del entorno, medidas

Verificadas en esta máquina antes de diseñar. No son suposiciones.

| Hecho | Valor | Consecuencia de diseño |
|---|---|---|
| Sistema | Windows 10 Pro build 19045 (22H2) | No hay Mica ni Acrylic nativo |
| `dwmapi.dll` | 10.0.19041 | Sí existe `DwmEnableBlurBehindWindow` |
| `TransparencyKey` | llave de color, no alfa | WinForms no pinta paneles translúcidos reales |
| Fuentes bonitas | Inter, Poppins, Aptos, Segoe UI Variable **ausentes** | La tipografía se apoya en Bahnschrift + Segoe UI |
| Fuentes disponibles | Bahnschrift (+9 variantes), Segoe UI (Light/Semilight/Semibold/Black), Cascadia Mono | Escala tipográfica viable sin instalar nada |

**Decisión tomada con el usuario:** blur real vía P/Invoke, con degradación automática a
fondo plano si el sistema no lo aplica. No se instala ninguna dependencia.

## 3. Arquitectura: el tema son datos, no código

El archivo nuevo `tools/theme.ps1` contiene los 4 temas como **datos puros**. Ninguna
lógica de presentación vive ahí dentro salvo el blend de color, que sí es cálculo.

Los 33 constructores existentes de la GUI pasan a pedir un **rol semántico** en lugar de un
color:

```
antes:   New-Button 'Publicar' 'accent'      ->  $normal = Color '#A43F34'
ahora:   New-Button 'Publicar' 'danger'      ->  $normal = $style.Rest.Danger.Base
```

Consecuencia buscada: cambiar de tema es sustituir una tabla de datos. Ningún control sabe
de qué color es, solo de qué **papel** juega.

### 3.1 Forma de un tema

```powershell
@{
  Key       = 'crystal-dark'
  Name      = 'Cristal oscuro'
  Kind      = 'glass'            # glass | flat
  Blur      = $true              # solo si Kind = glass
  Base      = '#0B1220'          # fondo de la ventana
  Text      = [ordered]@{ Primary='#F1F5FB'; Secondary='#9FB0C7'; Disabled='#5B6B80' }
  Surface   = [ordered]@{ Base='#131C2B'; Raised='#1A2536'; Soft='#0F1826'; Hover='#22314A' }
  Border    = [ordered]@{ Base='#24344A'; Strong='#38506E' }
  Rest      = [ordered]@{
    Primary = @{ Base='#1E88B8'; Hover='#25A0D6'; Fore='#04121C' }
    Danger  = @{ Base='#B04A3F'; Hover='#C85A4C'; Fore='#FFF4F2' }
    Success = @{ Base='#2E9E77'; Hover='#37B98C'; Fore='#03150E' }
    Warning = @{ Base='#B58A2E'; Hover='#CBA03C'; Fore='#1A1204' }
  }
  Radius    = 10
  Spacing   = 4                  # rejilla base en px
  Shadow    = [ordered]@{ Depth=18; Alpha=52; Y=4 }
  Motion    = [ordered]@{ Fast=120; Normal=180; Slow=240; Easing='easeOutCubic' }
  Font      = [ordered]@{ Display='Bahnschrift'; Body='Segoe UI'; Mono='Cascadia Mono' }
}
```

### 3.2 Los 4 temas

| Clave | Nombre | Kind | Fondo | Uso |
|---|---|---|---|---|
| `crystal-dark` | Cristal oscuro | glass | azul profundo | Por defecto |
| `crystal-light` | Cristal claro | glass | gris azulado claro | Luz diurna, texto oscuro |
| `midnight` | Nocturno | glass | azul casi negro, acento cian | identidad de marca |
| `flat` | PLANE | flat | gris sólido, bordes nítidos | VMs, bajo rendimiento, sin blur |

Los cuatro comparten **estructura de claves**. Un tema que le falte una clave se rechaza al
cargar, con mensaje explícito, en vez deShown en negro.

## 4. Cristal: qué es real y qué es simulado

Ser explícito aquí evita afirmaciones falsas después.

**Real:** el fondo de la ventana se difumina con `DwmEnableBlurBehindWindow`. El escritorio
se ve borroso detrás de la aplicación. Se hace con P/Invoke una vez, al crear el formulario.

**Simulado:** los paneles encima. `Panel` de WinForms no admite alfa, así que un "panel de
cristal" es un color **pre-mezclado** contra el color de fondo esperado:

```
blend(Superficie, Fondo, 0.14)   # 14 % de superficie sobre fondo
```

Para que no se note la mentira, cada panel se dibuja con un borde de 1 px del color
`Border.Base` desplazado 1 px hacia arriba y claro, que es lo que produce el canto
característico del cristal. La tridimensionalidad viene de ese borde, no de la transparencia.

**Degradación:** si `DwmEnableBlurBehindWindow` no cambia nada —VM, sesión remota, GPU
deshabilitada— se detecta comparando el fondo antes y después de la llamada. Si no cambió,
el tema activo pasa a `Kind='flat'` para esa sesión y se avisa en el panel de log. Nunca se
ve roto.

## 5. Sistema de movimiento

Todos los valores salen de `Motion` del tema, así que el tema plano puede tenerlos a 0.

El tema **PLANE** es el que se muestra en el selector como cuarta opción, y su etiqueta visible
en la interfaz es exactamente `PLANE`, en mayúsculas, sin traducir.

| Interacción | Duración | Curva | Efecto |
|---|---|---|---|
| Hover de botón | `Fast` 120 ms | easeOutCubic | Color y borde interpolados, no salto |
| Presión | 90 ms | easeOutQuad | Escala 0.97 + brillo |
| Cambio de tema | `Slow` 240 ms | easeInOutQuad | Fundido de opacidad de todos los paneles |
| Cambio de pestaña | `Normal` 180 ms | easeOutCubic | Desplazamiento de 12 px + fundido del contenido |
| Entrada de panel | `Normal` 180 ms | easeOutCubic | Desplazamiento de 16 px y fundido, escalonado 40 ms por panel |
| Validación correcta | `Normal` 180 ms | spring suave | Pulso del borde, una vez |
| Error | `Fast` 120 ms | 3 oscilaciones | Sacudida horizontal de 6 px |
| Escritura en el log | `Fast` 120 ms | lineal | La última línea se atenúa de 100 % a 55 % |

**Todo por `System.Windows.Forms.Timer`, nunca `Thread.Sleep`.** Una animación que bloquee
el hilo de la interfaz convertiría la app en un juguete.

Una sola fuente de reloj: un `Timer` de 16 ms (`AnimationFrame`) que adelanta todas las
animaciones activas. Es el patrón correcto y evita N timers compitiendo.

## 6. Lo que cambia de verdad en cada control

Hoy todo es `Panel` + `Label` plano. Esto es lo que se rehace:

**Botones.** Hoy `FlatStyle='Flat'` con un rectángulo sólido. Pasa a: esquinas redondeadas de
radio `Radius` mediante `Region`, borde que cambia con el hover, y fondo que interpola en
`Fast` ms. Los 5 estados —normal, hover, pressed, disabled, focus— quedan definidos en el
tema. El anillo de foco debe seguir siendo visible: es navegación por teclado, no decoración.

**Paneles y tarjetas.** `New-Card` deja de ser un rectángulo con `BorderStyle='FixedSingle'`.
Gana: esquinas redondeadas, borde claro en el canto superior, sombra inferior suave pintada
en un panel hermano desplazado, y entrada animada escalonada.

**Tipografía.** Escala consistente con tres niveles y pesos reales de Segoe UI:

| Nivel | Fuente | Tamaño | Peso |
|---|---|---|---|
| Display | Bahnschrift SemiBold | 22 | — |
| Título de sección | Segoe UI Semibold | 13.5 | Semibold |
| Cuerpo | Segoe UI | 9.5 | Regular |
| Dato / etiqueta | Segoe UI Semibold | 7.7 | Semibold, versalitas, `Muted` |
| Log | Cascadia Mono | 8.6 | Regular |

Se elimina el `New-Label` con tamaños sueltos (`19`, `12.5`, `9`, `8`, `7.7`, `7.3`, `7.2`,
`7.5`): nueve tamaños arbitrarios replaced por cinco con nombre.

**Iconos.** Hoy son emoji (`🧩`, `✈️`, `🎨`, `🌐`, `🧬`, `🥚`, `🛒`), que se renderizan con
fuentes distintas según el equipo y no aceptan color. Se sustituyen por **iconos vectoriales
tintados con GDI+**, dibujados con `GraphicsPath` en el color del tema. Se llegaran 7
iconos: script, cohete, paleta, globo, ADN, huevo, cesta. Mismo lenguaje visual en toda la
app, escalan sin pixelarse, y en el tema plano se ven nítidos donde un emoji se ve borroso.

**Rejilla.** Todo el espaciado pasa a múltiplos de 4 px, tomado de `Spacing`. Hoy conviven
valores como 3, 5, 8, 10, 12, 13, 22, 59.

## 7. Cambio de tema en caliente

1. `Apply-Theme $key` carga la tabla, valida que estén todas las claves, y la asigna a
   `$script:theme`.
2. Recorre un registro de todos los controles sensibles al tema (etiquetas, botones, paneles,
   grid, textboxes, log), aplicando los tokens correspondientes.
3. Lanza la animación de fundido de 240 ms.
4. Guarda la clave en `%LOCALAPPDATA%\PokeGrid-Shop-Publisher\theme.txt` para recordarla.

El registro se llena solo: cada constructor que cree un control lo apunta. Nadie escribe a
mano una lista de controles que actualizar.

## 8. Estructura de archivos

```
PokeGrid-Shop-Publisher.ps1    <- lógica intacta, aspecto por tokens
tools/theme.ps1                <- NUEVO: 4 temas como datos + blend + validación
tools/ui.ps1                   <- NUEVO: helpers visuales reutilizables
                                  (iconos GDI+, región redondeada, sombras,
                                   interpolación de color, easing, registro de tema)
```

Se **añaden** dos archivos. No se mueve ni se divide ninguno de los existentes.

## 9. Verificación

Todo lo que sigue debe ser cierto **antes** de entregar.

| # | Comprobación | Cómo |
|---|---|---|
| 1 | La lógica no cambió | El smoke test existente sigue en verde sin haberlo modificado |
| 2 | Los 4 temas cargan | Un test abre la GUI en cada tema y falla si falta una clave |
| 3 | Contraste legible | Los pares texto/fondo de los 4 temas superan 4.5:1, medido, no estimado |
| 4 | El cristal cae con elegancia | Con el blur desactivado, la app sigue usable y lo dice en el log |
| 5 | Las animaciones no bloquean | El smoke test mide que la interfaz responde durante una animación |
| 6 | Nada se sale de la ventana | Un test redimensiona a 880×650 (el mínimo) y comprueba que no hay recortes |
| 7 | El aspecto es reproducible | `-ScreenshotPath` genera las 4 capturas y se comparan entre sí |
| 8 | Cero regresión funcional | Los 15 tests del repo siguen en verde |

El punto 3 es el que más importa: un rediseño bonito con texto ilegible es peor que no
rediseñar. La medición de contraste se calcula con la fórmula WCAG real sobre los colores
finales, mezclados como los mezclaría la app.

## 10. Fuera de alcance

**No se reordena el layout.** Las 3 pestañas, las 3 secciones por pestaña, la barra lateral
y el panel de log se quedan donde están. Moverlos sería un rediseño funcional.

**No se añaden dependencias.** Ni PInvoke wrapper generado, ni paquete NuGet, ni fuente
descargada. Solo `Add-Type` con C# embebido para el P/Invoke, que ya es la práctica del
proyecto.

**No se toca el backend.** `publish-script.ps1`, `publish-launcher.ps1`,
`remove-script.ps1`, `git-helper.ps1`, `validate-catalog.ps1`, el workflow y
`catalog.json` quedan intactos.

**No se soportan temas personalizados** escritos por el usuario. Cuatro temas fijos.

## 11. Riesgos

| Riesgo | Efecto | Mitigación |
|---|---|---|
| Cristal con texto claro ilegible sobre escritorio variable | Ilegible | Contraste medido en los 4 temas; margen generoso; `crystal-light` con superficie más opaca |
| Animaciones en VM lenta | Interfaz arrastrada | Duraciones del tema, y `flat` con `Motion` a 0 |
| P/Invoke falla o corrompe la pila | Crash al abrir | Todo en `Add-Type` con `try/catch`; si falla, tema plano desde el principio |
| 33 constructoresmodifican en lugar de 5 | Diff grande, riesgo de regresión | El smoke test cubre la construcción de los 3 tabs; se migra por capas, no de una vez |
| Emoji → iconos GDI+ cambia el aspecto del catálogo | Otros pueden extrañar los emojis | Los 7 iconos reproducen el significado de los 7 anteriores |
| El registro de tema se desincroniza | Un control queda del color anterior | El registro se llena en los constructores; un test verifica que el número de controles registrados coincide con los reales |

## 12. Verificación de la afirmación de cristal

Punto que un revisor comprobará primero, porque es donde se suelen exagerar las
afirmaciones:

- **Verdadero:** el fondo de la ventana está desenfocado por el compositor del sistema.
- **Falso:** los paneles no son translúcidos. Son colores opacos pre-mezclados que lo
  aparentan, porque WinForms no permite alfa por píxel en un `Panel`.
- **Cierto en Win10, no en Win11:** no se usa Mica ni Acrylic, que requieren Windows 11.

Esta distinción aparece también en la documentación para el usuario, para que nadie lo lea
como algo que no es.
