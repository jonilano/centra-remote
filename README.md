# Centra Remote

A Bluetooth treadmill remote for Bluefy on iPhone. Static HTML, CSS and JavaScript, hosted on GitHub Pages without a sign-in requirement.

Open the site in Bluefy, tap Connect, and choose RZ_TreadMil. Start uses the treadmill countdown; + and − adjust speed by 0.1 km/h while running; Stop stops the belt. Controls are limited to 1.0–6.0 km/h.

Validated on one Centra treadmill: Start, Stop and both speed buttons. The observed empty-belt auto-stop does not occur while the user walks. Compatibility with other models is not established.

Bluetooth communication happens locally on the phone. Diagnostics stay in page memory unless copied. Keep Bluefy in the foreground. Use the treadmill power switch if controls do not respond.

## Hosting

GitHub Pages publishes the root of the main branch. No build step or secrets are needed. The Sites deployment is maintained separately.

## Protocol reference

Packet encoding was informed by the QZ ZIPRO driver and the original SmartTreadmill capture discussed in https://github.com/cagnulein/qdomyos-zwift/issues/1344, then checked against this treadmill's diagnostic replies. The JavaScript implementation is local to this project.
