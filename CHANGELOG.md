# Changelog

Release notes per desktop version, in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) form. The release workflow copies the section matching the desktop version into the GitHub release and the in-app update dialog; a version without a section ships without notes. Mobile- or core-only items go under the same version, prefixed "Mobile:".

## [Unreleased]

### Added
- Speaker groups on the Workspace, as tiles beside the speakers. A group's gain, mute, delay and polarity sit on top of every output its speakers are linked to, across amps. A speaker can be in several groups: gains and delays add up, any mute mutes, and two polarity flips cancel. A speaker's preset still reads Match. Add a group from the speaker pane's bar, and choose its speakers with Design's new Group tool. Selecting a speaker outlines its groups, and selecting a group outlines its speakers.
- Tune mode: the Mute, Gain, Delay and Polarity tools act on the selected speakers and groups, in absolute or relative steps. A speaker's tile shows its own gain and, in brackets, the gain with its groups. A red dot means it is muted; the tooltip says by what.
- Unlinking or removing a speaker now takes its groups' values off its outputs. A group change that would push an output past its range is refused as a whole, and the refusal names the output.
- After reading settings from an amp whose speakers are in groups, the app asks whether those values already included the groups. If another project or other software wrote the amp, the values didn't include them, and "Put groups back on top" writes the groups to the amp again.
- The output volume popover has a dotted orange border, because output volume is never part of a speaker preset.

## [0.3.12] - 2026-11-03

### Changed
- Linking a project speaker sets the output's load to the speaker's nominal impedance divided by the number of cabinets in parallel, so the limiter's watt figures match.
- Core: the fingerprint, push planning and CVR driver are split into modules; no behaviour change.

### Fixed
- Speakers added to the Workspace canvas no longer pile up on top of each other: each takes the next free spot and stays there.
- Applying a speaker, bridging or renaming an online amp no longer undoes project changes to that amp made while it was being written.
- A change to a project amp made outside its editor now reaches the amp the project is following, instead of being saved to the project and then undone by the amp's next reading. An amp locked by a difference refuses such changes rather than having the whole project written over it.
- Removing an amp from the Workspace that fails now says why, instead of leaving the dialog open with no message.

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
