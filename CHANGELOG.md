# Changelog

Release notes per desktop version, in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) form. The release workflow copies the section matching the desktop version into the GitHub release and the in-app update dialog; a version without a section ships without notes. Mobile- or core-only items go under the same version, prefixed "Mobile:".

## [Unreleased]

### Changed
- Linking a project speaker sets the output's load to the speaker's nominal impedance divided by the number of cabinets in parallel, so the limiter's watt figures match.

### Fixed
- Speakers added to the Workspace canvas no longer pile up on top of each other: each takes the next free spot and stays there.
- Applying a speaker, bridging or renaming an online amp no longer undoes project changes to that amp made while it was being written.
- A change to a project amp made outside its editor now reaches the amp the project is following, instead of being saved to the project and then undone by the amp's next reading. An amp locked by a difference refuses such changes rather than having the whole project written over it.

## [0.3.11] - 2026-11-03

### Added
- The update dialog lists what changed in every version between the installed one and the update.
- Speaker Library: edit speakers as drafts and save them in one step; add or remove ways.
- Speakers carry the whole output (EQ, limiters, delay, polarity, trim, noise gate, power mode, FIR) apart from volume and load.
- Speaker ways are laid out like an output row, with EQ, FIR and limiter tiles that open the usual editors.

## [0.3.10] - 2026-11-02

### Fixed
- Firmware 1.1.8: Gain/SEN now follow the volume fader, and the app no longer sends the gain command this firmware uses for LCD contrast.

## [0.3.9] - 2026-11-02

### Added
- Bug reports can include up to three screenshots, picked or pasted.
