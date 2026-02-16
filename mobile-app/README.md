# HomePiNAS Mobile App

App móvil para gestionar tu NAS HomePiNAS desde el teléfono.

## Stack
- **React Native** + **Expo** (SDK 54)
- **TypeScript**
- **Expo Router** (navegación)

## Desarrollo

```bash
# Instalar dependencias
npm install

# Iniciar servidor de desarrollo
npm start

# Android
npm run android

# iOS
npm run ios
```

## Estructura

```
app/              # Expo Router screens
  (tabs)/         # Tab navigation
    index.tsx     # Dashboard
    storage.tsx   # Storage
    files.tsx     # File Station
    backup.tsx    # Active Backup
    settings.tsx  # Ajustes
components/       # Componentes reutilizables
services/         # API, discovery, push
hooks/            # Custom hooks
assets/           # Imágenes, iconos
```

## Conectar al NAS

1. Abre la app
2. Introduce la IP del NAS (ej: `192.168.1.123:3001`)
3. Login con tus credenciales
4. ¡Listo!

## Roadmap

- [ ] Fase 1: MVP (Dashboard + Active Backup)
- [ ] Fase 2: File Station
- [ ] Fase 3: Storage + Usuarios
- [ ] Fase 4: Push notifications + VPN

Ver [PLAN.md](./PLAN.md) para detalles completos.
